import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthGuard } from "../auth/auth.guard";
import { AuthedUser } from "../auth/auth.types";
import { Request } from "express";
import * as crypto from "crypto";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

class CreateInviteDto {
  @IsInt()
  @Min(1)
  @Max(3)
  targetLevel!: number; // admin: 3, L3: 2, L2: 1

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  maxUses?: number; // default 3

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(60 * 24 * 14)
  ttlMinutes?: number; // default 7 days

  @IsOptional()
  @IsString()
  note?: string;
}

@Controller("invites")
@UseGuards(AuthGuard)
export class InvitesController {
  constructor(private prisma: PrismaService) {}

  private allowedTargetLevel(role: string, level: number) {
    if (role === "ADMIN") return 3; // admin can invite L3
    if (level === 3) return 2;      // L3 can invite L2
    if (level === 2) return 1;      // L2 can invite L1
    return 0;                       // L1 cannot invite
  }

  @Post()
  async create(
    @Req() req: Request & { user: AuthedUser },
    @Body() body: CreateInviteDto
  ) {
    const me = req.user;
    const allowed = this.allowedTargetLevel(me.role, me.level);

    if (allowed === 0) return { ok: false, message: "Yetkisiz (davet oluşturamaz)" };
    if (body.targetLevel !== allowed) {
      return { ok: false, message: `Sadece L${allowed} için davet oluşturabilirsin.` };
    }

    // 3 kuralı: inviter direct downline < 3 (admin hariç istersen kaldırırız)
    if (me.role !== "ADMIN") {
      const direct = await this.prisma.user.count({ where: { leaderId: me.id } });
      if (direct >= 3) {
        return { ok: false, message: "3 kuralı: direkt ekibin dolu (3 kişi)." };
      }
    }

    const token = crypto.randomBytes(24).toString("hex");
    const ttlMinutes = body.ttlMinutes ?? 60 * 24 * 7;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    const inv = await this.prisma.inviteToken.create({
      data: {
        token,
        inviterId: me.id,
        targetLevel: body.targetLevel,
        maxUses: body.maxUses ?? 3,
        note: body.note ?? null,
        expiresAt,
      },
      select: { token: true, targetLevel: true, maxUses: true, usedCount: true, expiresAt: true },
    });

    const base = process.env.WEB_BASE_URL ?? "http://localhost:3000";
    return { ok: true, invite: inv, link: `${base}/join?token=${inv.token}` };
  }

  @Get("mine")
  async mine(@Req() req: Request & { user: AuthedUser }) {
    const me = req.user;
    const base = process.env.WEB_BASE_URL ?? "http://localhost:3000";

    const items = await this.prisma.inviteToken.findMany({
      where: {
        inviterId: me.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        token: true,
        createdAt: true,
        expiresAt: true,
        targetLevel: true,
        maxUses: true,
        usedCount: true,
        note: true,
      },
    });

    return {
      ok: true,
      items: items.map((x) => ({ ...x, link: `${base}/join?token=${x.token}` })),
    };
  }

  @Post("revoke")
  async revoke(@Req() req: Request & { user: AuthedUser }, @Body() body: { token: string }) {
    const me = req.user;

    const inv = await this.prisma.inviteToken.findUnique({ where: { token: body.token } });
    if (!inv) return { ok: false, message: "Davet bulunamadı" };
    if (inv.inviterId !== me.id && me.role !== "ADMIN") return { ok: false, message: "Yetkisiz" };

    await this.prisma.inviteToken.update({
      where: { token: body.token },
      data: { revokedAt: new Date() },
    });

    return { ok: true };
  }
}