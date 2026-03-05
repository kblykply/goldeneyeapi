import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthGuard } from "../auth/auth.guard";
import { AuthedUser } from "../auth/auth.types";
import { Request } from "express";
import { TeamService } from "./team.service";

type TreeNode = {
  id: string;
  fullName: string;
  phoneE164: string;
  level: number;
  role: string;
  leaderId: string | null;

  avatarUrl: string | null;

  lastSeenAt: string | null;
  online: boolean;
  stats: {
    presentationsToday: number;
    minutesToday: number;
    presentations7d: number;
    minutes7d: number;
  };
  children: TreeNode[];
};

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

@Controller("team")
@UseGuards(AuthGuard)
export class TeamController {
  constructor(private prisma: PrismaService, private team: TeamService) {}

  // ✅ GET /team/tree
  @Get("tree")
  async tree(
    @Req() req: Request & { user: AuthedUser },
    @Query("rootId") rootId?: string
  ) {
    const me = req.user;
    const actualRootId = rootId ?? me.id;

    if (me.role !== "ADMIN" && actualRootId !== me.id) {
      return { ok: false, message: "Forbidden" };
    }

    const rootUser = await this.prisma.user.findUnique({
      where: { id: actualRootId },
      select: {
        id: true,
        fullName: true,
        phoneE164: true,
        level: true,
        role: true,
        leaderId: true,
        lastSeenAt: true,
        avatarUrl: true,
      },
    });

    if (!rootUser) return { ok: false, message: "Root not found" };

    const all: Array<{
      id: string;
      fullName: string;
      phoneE164: string;
      level: number;
      role: any;
      leaderId: string | null;
      lastSeenAt: Date | null;
      avatarUrl: string | null;
    }> = [rootUser];

    let frontier = [actualRootId];
    const visited = new Set(frontier);

    while (frontier.length > 0) {
      const children = await this.prisma.user.findMany({
        where: { leaderId: { in: frontier } },
        select: {
          id: true,
          fullName: true,
          phoneE164: true,
          level: true,
          role: true,
          leaderId: true,
          lastSeenAt: true,
          avatarUrl: true,
        },
      });

      const next: string[] = [];
      for (const u of children) {
        if (!visited.has(u.id)) {
          visited.add(u.id);
          all.push(u);
          next.push(u.id);
        }
      }
      frontier = next;
    }

    const ids = all.map((u) => u.id);

    const todayStart = startOfToday();
    const weekStart = daysAgo(7);

    const presToday = await this.prisma.presentation.groupBy({
      by: ["salespersonId"],
      where: { salespersonId: { in: ids }, createdAt: { gte: todayStart } },
      _count: { _all: true },
      _sum: { durationSec: true },
    });

    const pres7d = await this.prisma.presentation.groupBy({
      by: ["salespersonId"],
      where: { salespersonId: { in: ids }, createdAt: { gte: weekStart } },
      _count: { _all: true },
      _sum: { durationSec: true },
    });

    const todayMap = new Map<string, { c: number; s: number }>();
    for (const row of presToday) {
      todayMap.set(row.salespersonId, {
        c: row._count._all,
        s: row._sum.durationSec ?? 0,
      });
    }

    const weekMap = new Map<string, { c: number; s: number }>();
    for (const row of pres7d) {
      weekMap.set(row.salespersonId, {
        c: row._count._all,
        s: row._sum.durationSec ?? 0,
      });
    }

    const byId = new Map<string, TreeNode>();
    const now = Date.now();
    const onlineWindowMs = 2 * 60 * 1000;

    for (const u of all) {
      const t = todayMap.get(u.id);
      const w = weekMap.get(u.id);

      const last = u.lastSeenAt ? u.lastSeenAt.getTime() : null;
      const online = last ? now - last <= onlineWindowMs : false;

      byId.set(u.id, {
        id: u.id,
        fullName: u.fullName,
        phoneE164: u.phoneE164,
        level: u.level,
        role: String(u.role),
        leaderId: u.leaderId,
        avatarUrl: u.avatarUrl ?? null,
        lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
        online,
        stats: {
          presentationsToday: t?.c ?? 0,
          minutesToday: Math.round(((t?.s ?? 0) / 60) * 10) / 10,
          presentations7d: w?.c ?? 0,
          minutes7d: Math.round(((w?.s ?? 0) / 60) * 10) / 10,
        },
        children: [],
      });
    }

    for (const node of byId.values()) {
      if (node.leaderId && byId.has(node.leaderId)) {
        byId.get(node.leaderId)!.children.push(node);
      }
    }

    for (const node of byId.values()) {
      node.children.sort((a, b) => a.fullName.localeCompare(b.fullName));
    }

    return { ok: true, root: byId.get(actualRootId) };
  }

  // ✅ GET /team/member/:id
  @Get("member/:id")
  async member(
    @Req() req: Request & { user: AuthedUser },
    @Param("id") id: string
  ) {
    const me = req.user;

    if (me.role !== "ADMIN") {
      const subtree = await this.team.getSubtreeIds(me.id);
      if (!subtree.has(id)) return { ok: false, message: "Forbidden" };
    }

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        phoneE164: true,
        level: true,
        role: true,
        leaderId: true,
        lastSeenAt: true,
        createdAt: true,
        avatarUrl: true,
      },
    });

    if (!user) return { ok: false, message: "Not found" };

    const now = Date.now();
    const last = user.lastSeenAt ? user.lastSeenAt.getTime() : null;
    const online = last ? now - last <= 2 * 60 * 1000 : false;

    const todayStart = startOfToday();
    const d7 = daysAgo(7);
    const d30 = daysAgo(30);

    const [todayAgg, agg7, agg30] = await Promise.all([
      this.prisma.presentation.aggregate({
        where: { salespersonId: id, createdAt: { gte: todayStart } },
        _count: { _all: true },
        _sum: { durationSec: true },
      }),
      this.prisma.presentation.aggregate({
        where: { salespersonId: id, createdAt: { gte: d7 } },
        _count: { _all: true },
        _sum: { durationSec: true },
      }),
      this.prisma.presentation.aggregate({
        where: { salespersonId: id, createdAt: { gte: d30 } },
        _count: { _all: true },
        _sum: { durationSec: true },
      }),
    ]);

    const [pendingAuthority, approved, rejected] = await Promise.all([
      this.prisma.contract.count({
        where: { salespersonId: id, status: "CUSTOMER_CONFIRMED" },
      }),
      this.prisma.contract.count({
        where: { salespersonId: id, status: "APPROVED" },
      }),
      this.prisma.contract.count({
        where: { salespersonId: id, status: "REJECTED" },
      }),
    ]);

    const directTeam = await this.prisma.user.findMany({
      where: { leaderId: id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        fullName: true,
        phoneE164: true,
        level: true,
        role: true,
        lastSeenAt: true,
        avatarUrl: true,
      },
    });

    const recentPresentations = await this.prisma.presentation.findMany({
      where: { salespersonId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        createdAt: true,
        openedAt: true,
        endedAt: true,
        durationSec: true,
        customer: { select: { fullName: true, phoneE164: true } },
      },
    });

    return {
      ok: true,
      user: {
        ...user,
        lastSeenAt: user.lastSeenAt ? user.lastSeenAt.toISOString() : null,
        online,
      },
      stats: {
        today: {
          presentations: todayAgg._count._all,
          minutes: Math.round(((todayAgg._sum.durationSec ?? 0) / 60) * 10) / 10,
        },
        d7: {
          presentations: agg7._count._all,
          minutes: Math.round(((agg7._sum.durationSec ?? 0) / 60) * 10) / 10,
        },
        d30: {
          presentations: agg30._count._all,
          minutes: Math.round(((agg30._sum.durationSec ?? 0) / 60) * 10) / 10,
        },
        contracts: { pending: pendingAuthority, approved, rejected },
      },
      directTeam: directTeam.map((x) => ({
        ...x,
        lastSeenAt: x.lastSeenAt ? x.lastSeenAt.toISOString() : null,
        online: x.lastSeenAt ? Date.now() - x.lastSeenAt.getTime() <= 2 * 60 * 1000 : false,
      })),
      recentPresentations: recentPresentations.map((p) => ({
        ...p,
        createdAt: p.createdAt.toISOString(),
        openedAt: p.openedAt ? p.openedAt.toISOString() : null,
        endedAt: p.endedAt ? p.endedAt.toISOString() : null,
      })),
    };
  }

  // ✅ NEW: Leader view – team contracts
  // GET /team/contracts?status=APPROVED (default)
  @Get("contracts")
  async teamContracts(
    @Req() req: Request & { user: AuthedUser },
    @Query("status") status?: string
  ) {
    const me = req.user;

    // subtree ids (includes me)
    const subtree = await this.team.getSubtreeIds(me.id);
    const ids = Array.from(subtree);

    // allow only known statuses
    const allowed = new Set([
      "DRAFT",
      "CUSTOMER_CONFIRM_PENDING",
      "CUSTOMER_CONFIRMED",
      "APPROVED",
      "REJECTED",
      "PENDING_MANAGER_APPROVAL",
    ]);

    const finalStatus = allowed.has(status ?? "")
      ? (status as any)
      : ("APPROVED" as any);

    const items = await this.prisma.contract.findMany({
      where: {
        status: finalStatus,
        salespersonId: { in: ids },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        customer: { select: { fullName: true, phoneE164: true } },
        salesperson: { select: { id: true, fullName: true, phoneE164: true, level: true, avatarUrl: true } },
        approvedBy: { select: { id: true, fullName: true, phoneE164: true, role: true } },
      },
    });

    return { ok: true, items };
  }
}