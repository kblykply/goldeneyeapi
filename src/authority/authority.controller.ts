import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthGuard } from "../auth/auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { Request } from "express";
import { AuthedUser } from "../auth/auth.types";
import { CommissionService } from "../commissions/commission.service";

class RejectDto {
  reason!: string;
}

@Controller("authority")
@UseGuards(AuthGuard, RolesGuard)
@Roles("AUTHORITY", "ADMIN")
export class AuthorityController {
  constructor(private prisma: PrismaService, private commissions: CommissionService) {}

  @Get("contracts")
  async list(@Query("status") status?: string) {
    const finalStatus = (status ?? "CUSTOMER_CONFIRMED") as any;

    const items = await this.prisma.contract.findMany({
      where: { status: finalStatus },
      orderBy: { createdAt: "desc" },
      include: {
        customer: { select: { fullName: true, phoneE164: true } },
        salesperson: { select: { id: true, fullName: true, phoneE164: true, level: true } },
      },
    });

    return { ok: true, items };
  }

  @Post("contracts/:id/approve")
  async approve(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const c = await this.prisma.contract.findUnique({
      where: { id },
      select: { status: true },
    });

    if (!c) return { ok: false, message: "Sözleşme bulunamadı" };
    if (c.status !== "CUSTOMER_CONFIRMED") {
      return { ok: false, message: "Onaya uygun değil (CUSTOMER_CONFIRMED olmalı)" };
    }

    // ✅ Single update
    await this.prisma.contract.update({
      where: { id },
      data: { status: "APPROVED", approvedById: req.user.id },
    });

    // ✅ Create commissions (idempotent in service)
    await this.commissions.calculateForApprovedContract(id);

    return { ok: true };
  }

  @Post("contracts/:id/reject")
  async reject(
    @Param("id") id: string,
    @Body() body: RejectDto,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const reason = (body.reason ?? "").trim();
    if (!reason) return { ok: false, message: "Reddetme sebebi gerekli" };

    const c = await this.prisma.contract.findUnique({
      where: { id },
      select: { status: true },
    });

    if (!c) return { ok: false, message: "Sözleşme bulunamadı" };
    if (c.status !== "CUSTOMER_CONFIRMED") {
      return { ok: false, message: "Reddetmeye uygun değil (CUSTOMER_CONFIRMED olmalı)" };
    }

    await this.prisma.contract.update({
      where: { id },
      data: {
        status: "REJECTED",
        approvedById: req.user.id,
        rejectedReason: reason,
      },
    });

    return { ok: true };
  }
}