import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthGuard } from "../auth/auth.guard";
import { Request } from "express";
import { AuthedUser } from "../auth/auth.types";

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

@Controller("me")
@UseGuards(AuthGuard)
export class MeController {
  constructor(private prisma: PrismaService) {}

  @Get("team")
  async team(@Req() req: Request & { user: AuthedUser }) {
    const me = req.user;

    const members = await this.prisma.user.findMany({
      where: { leaderId: me.id },
      select: {
        id: true,
        fullName: true,
        phoneE164: true,
        level: true,
        role: true,
        avatarUrl: true,
        lastSeenAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    return { ok: true, members };
  }

  @Get("stats")
  async stats(@Req() req: Request & { user: AuthedUser }) {
    const me = req.user;

    const todayStart = startOfToday();

    // ✅ 1) count() ile kesin sayı
    const presentationsToday = await this.prisma.presentation.count({
      where: { salespersonId: me.id, createdAt: { gte: todayStart } },
    });

    // ✅ 2) süre toplamı (ENDED olanlar dolu olur, OPENED olanlar 0 kalır)
    const presSum = await this.prisma.presentation.aggregate({
      where: { salespersonId: me.id, createdAt: { gte: todayStart } },
      _sum: { durationSec: true },
    });

    const totalPresentationMinutesToday =
      Math.round(((presSum._sum.durationSec ?? 0) / 60) * 10) / 10;

    // ✅ Sprint 3: Yetkili onayı bekleyen = CUSTOMER_CONFIRMED
    const pendingAuthority = await this.prisma.contract.count({
      where: { salespersonId: me.id, status: "CUSTOMER_CONFIRMED" },
    });

    const approved = await this.prisma.contract.count({
      where: { salespersonId: me.id, status: "APPROVED" },
    });

    const rejected = await this.prisma.contract.count({
      where: { salespersonId: me.id, status: "REJECTED" },
    });

    return {
      ok: true,
      user: me,
      kpis: {
        presentationsToday,
        totalPresentationMinutesToday,
        contractsPendingApproval: pendingAuthority,
        contractsApproved: approved,
        contractsRejected: rejected,
      },
    };
  }

  // GET /me/contracts?status=APPROVED
  @Get("contracts")
  async myContracts(
    @Req() req: Request & { user: AuthedUser },
    @Query("status") status?: string
  ) {
    const me = req.user;

    const allowed = new Set([
      "DRAFT",
      "CUSTOMER_CONFIRM_PENDING",
      "CUSTOMER_CONFIRMED",
      "APPROVED",
      "REJECTED",
      "PENDING_MANAGER_APPROVAL", // şemanda duruyorsa sorun değil
    ]);

    const st = allowed.has(status ?? "") ? (status as any) : ("APPROVED" as any);

    const items = await this.prisma.contract.findMany({
      where: { salespersonId: me.id, status: st },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        customer: { select: { fullName: true, phoneE164: true } },
        salesperson: { select: { id: true, fullName: true, phoneE164: true, level: true } },
        approvedBy: { select: { id: true, fullName: true, phoneE164: true, role: true } },
      },
    });

    return { ok: true, items };
  }
}