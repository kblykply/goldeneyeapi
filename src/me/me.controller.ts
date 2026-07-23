import { Controller, Get, Query, Req } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { Request } from "express";
import { AuthedUser } from "../auth/auth.types";

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

@Controller("me")
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

    // Tek aggregate (sayı + süre toplamı) + tek groupBy (3 status sayacı), paralel
    const [presAgg, contractCounts] = await Promise.all([
      this.prisma.presentation.aggregate({
        where: { salespersonId: me.id, createdAt: { gte: todayStart } },
        _count: { _all: true },
        _sum: { durationSec: true },
      }),
      this.prisma.contract.groupBy({
        by: ["status"],
        where: { salespersonId: me.id, status: { in: ["CUSTOMER_CONFIRMED", "APPROVED", "REJECTED"] } },
        _count: { _all: true },
      }),
    ]);

    const presentationsToday = presAgg._count._all;
    const totalPresentationMinutesToday =
      Math.round(((presAgg._sum.durationSec ?? 0) / 60) * 10) / 10;

    const byStatus = new Map(contractCounts.map((r) => [r.status, r._count._all]));
    // Yetkili onayı bekleyen = CUSTOMER_CONFIRMED
    const pendingAuthority = byStatus.get("CUSTOMER_CONFIRMED") ?? 0;
    const approved = byStatus.get("APPROVED") ?? 0;
    const rejected = byStatus.get("REJECTED") ?? 0;

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

  // GET /me/presentations?status=ENDED
  @Get("presentations")
  async myPresentations(
    @Req() req: Request & { user: AuthedUser },
    @Query("status") status?: string,
  ) {
    const me = req.user;

    const validStatuses = new Set(["CREATED", "OTP_SENT", "OPENED", "ENDED"]);
    const where: Prisma.PresentationWhereInput = { salespersonId: me.id };
    if (status && validStatuses.has(status)) where.status = status as Prisma.EnumPresentationStatusFilter;

    const items = await this.prisma.presentation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        createdAt: true,
        status: true,
        unitType: true,
        weekOfYear: true,
        durationSec: true,
        endedAt: true,
        customer: { select: { id: true, fullName: true, phoneE164: true } },
      },
    });

    return { ok: true, items };
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
        customPaymentPlan: {
          select: {
            installments: { select: { baseAmountCents: true } },
          },
        },
      },
    });

    return { ok: true, items };
  }
}