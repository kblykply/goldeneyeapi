import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { IsNumber, IsOptional, Max, Min } from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { CommissionService } from "./commission.service";
import { AuthedUser } from "../auth/auth.types";
import { Request } from "express";
import { TeamService } from "../team/team.service";

const ALLOWED_STATUS = new Set(["PENDING", "PAYABLE", "PAID"]);

class UpdateConfigDto {
  @IsOptional() @IsNumber() @Min(0) @Max(1) rmRate?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) adminRate?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) agencyRate?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) lvl3Rate?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) lvl2Rate?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) lvl1Rate?: number;
}

@Controller("commissions")
export class CommissionsController {
  constructor(private prisma: PrismaService, private team: TeamService, private commissionService: CommissionService) {}

  /**
   * GET /commissions/config (ADMIN only)
   */
  @Get("config")
  async getConfig(@Req() req: Request & { user: AuthedUser }) {
    if (req.user.role !== "ADMIN") return { ok: false, message: "Yetkisiz" };
    const config = await this.commissionService.getConfig();
    return { ok: true, config };
  }

  /**
   * PATCH /commissions/config (ADMIN only)
   */
  @Patch("config")
  async updateConfig(
    @Req() req: Request & { user: AuthedUser },
    @Body() body: UpdateConfigDto,
  ) {
    if (req.user.role !== "ADMIN") return { ok: false, message: "Yetkisiz" };
    const data: Record<string, number> = {};
    if (body.rmRate !== undefined) data.rmRate = body.rmRate;
    if (body.adminRate !== undefined) data.adminRate = body.adminRate;
    if (body.agencyRate !== undefined) data.agencyRate = body.agencyRate;
    if (body.lvl3Rate !== undefined) data.lvl3Rate = body.lvl3Rate;
    if (body.lvl2Rate !== undefined) data.lvl2Rate = body.lvl2Rate;
    if (body.lvl1Rate !== undefined) data.lvl1Rate = body.lvl1Rate;
    const config = await this.prisma.commissionConfig.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", ...data },
      update: data,
    });
    return { ok: true, config };
  }

  /**
   * GET /commissions/me?status=PENDING
   */
  @Get("me")
  async myCommissions(
    @Req() req: Request & { user: AuthedUser },
    @Query("status") status?: string
  ) {
    const me = req.user;

    const st = ALLOWED_STATUS.has(status ?? "") ? (status as any) : undefined;

    const items = await this.prisma.commission.findMany({
      where: {
        userId: me.id,
        ...(st ? { status: st } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        contract: {
          include: {
            customer: { select: { fullName: true, phoneE164: true } },
            salesperson: { select: { id: true, fullName: true, phoneE164: true, level: true } },
            approvedBy: { select: { id: true, fullName: true, role: true } },
          },
        },
      },
    });

    return { ok: true, items };
  }

  /**
   * GET /commissions/team?status=PENDING
   * Leader view: subtree's commissions
   */
  @Get("team")
  async teamCommissions(
    @Req() req: Request & { user: AuthedUser },
    @Query("status") status?: string
  ) {
    const me = req.user;

    // Only leader-ish users (level >= 2), REGIONAL_MANAGER, AGENCY, ADMIN, or AUTHORITY can view team
    if (
      me.role !== "ADMIN" &&
      me.role !== "AUTHORITY" &&
      me.role !== "REGIONAL_MANAGER" &&
      (me.role as string) !== "AGENCY" &&
      me.level < 2
    ) {
      return { ok: false, message: "Yetkisiz (Leader L2+ veya Admin/Authority/RM/Agency)" };
    }

    const st = ALLOWED_STATUS.has(status ?? "") ? (status as any) : undefined;

    // subtree user ids (includes me)
    const subtree = await this.team.getSubtreeIds(me.id);
    const ids = Array.from(subtree);

    const items = await this.prisma.commission.findMany({
      where: {
        userId: { in: ids },
        ...(st ? { status: st } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        user: { select: { id: true, fullName: true, phoneE164: true, level: true } },
        contract: {
          include: {
            customer: { select: { fullName: true, phoneE164: true } },
            salesperson: { select: { id: true, fullName: true, phoneE164: true, level: true } },
            approvedBy: { select: { id: true, fullName: true, role: true } },
          },
        },
      },
    });

    return { ok: true, items };
  }

  /**
   * GET /commissions/admin?status=PENDING
   * Admin/Authority: all commissions
   */
  @Get("admin")
  async adminCommissions(
    @Req() req: Request & { user: AuthedUser },
    @Query("status") status?: string
  ) {
    const me = req.user;
    if (me.role !== "ADMIN" && me.role !== "AUTHORITY") {
      return { ok: false, message: "Yetkisiz (Admin/Authority)" };
    }

    const st = ALLOWED_STATUS.has(status ?? "") ? (status as any) : undefined;

    const items = await this.prisma.commission.findMany({
      where: {
        ...(st ? { status: st } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        user: { select: { id: true, fullName: true, phoneE164: true, level: true } },
        contract: {
          include: {
            customer: { select: { fullName: true, phoneE164: true } },
            salesperson: { select: { id: true, fullName: true, phoneE164: true, level: true } },
            approvedBy: { select: { id: true, fullName: true, role: true } },
          },
        },
      },
    });

    return { ok: true, items };
  }

  /**
   * POST /commissions/:id/mark-paid
   * Only Admin/Authority
   */
  @Post(":id/mark-paid")
  async markPaid(@Param("id") id: string, @Req() req: Request & { user: AuthedUser }) {
    const me = req.user;
    if (me.role !== "ADMIN" && me.role !== "AUTHORITY") {
      return { ok: false, message: "Yetkisiz (Admin/Authority)" };
    }

    await this.prisma.commission.update({
      where: { id },
      data: { status: "PAID" },
    });

    return { ok: true };
  }

  /**
   * POST /commissions/:id/mark-payable
   * Only Admin/Authority
   */
  @Post(":id/mark-payable")
  async markPayable(@Param("id") id: string, @Req() req: Request & { user: AuthedUser }) {
    const me = req.user;
    if (me.role !== "ADMIN" && me.role !== "AUTHORITY") {
      return { ok: false, message: "Yetkisiz (Admin/Authority)" };
    }

    await this.prisma.commission.update({
      where: { id },
      data: { status: "PAYABLE" },
    });

    return { ok: true };
  }
}