import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthGuard } from "../auth/auth.guard";
import { AuthedUser } from "../auth/auth.types";
import { Request } from "express";
import { TeamService } from "../team/team.service";

const ALLOWED_STATUS = new Set(["PENDING", "PAYABLE", "PAID"]);

@Controller("commissions")
@UseGuards(AuthGuard)
export class CommissionsController {
  constructor(private prisma: PrismaService, private team: TeamService) {}

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

    // Only leader-ish users (level >= 2) OR admin/authority can view team
    if (me.role !== "ADMIN" && me.role !== "AUTHORITY" && me.level < 2) {
      return { ok: false, message: "Yetkisiz (Leader L2+ veya Admin/Authority)" };
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