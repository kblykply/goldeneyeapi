import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthedUser } from "../auth/auth.types";
import { Request } from "express";
import * as crypto from "crypto";
import { IsInt, IsIn, IsOptional, IsString, Max, Min } from "class-validator";

class CreateInviteDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  targetLevel?: number;

  @IsOptional()
  @IsString()
  @IsIn(["REGIONAL_MANAGER"])
  targetRole?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  maxUses?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(60 * 24 * 14)
  ttlMinutes?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

@Controller("invites")
export class InvitesController {
  constructor(private prisma: PrismaService) {}

  /**
   * Returns what this user can invite:
   * - { allowedLevels: [3], allowedRoles: ["REGIONAL_MANAGER"] } for ADMIN
   * - { allowedLevels: [3], allowedRoles: [] } for REGIONAL_MANAGER
   * - { allowedLevels: [2], allowedRoles: [] } for L3
   * - { allowedLevels: [1], allowedRoles: [] } for L2
   * - { allowedLevels: [], allowedRoles: [] } for L1 (cannot invite)
   */
  private getAllowedTargets(role: string, level: number): { levels: number[]; roles: string[] } {
    if (role === "ADMIN") return { levels: [3], roles: ["REGIONAL_MANAGER"] };
    if (role === "REGIONAL_MANAGER") return { levels: [3], roles: [] };
    if (level === 3) return { levels: [2], roles: [] };
    if (level === 2) return { levels: [1], roles: [] };
    return { levels: [], roles: [] };
  }

  @Post()
  async create(
    @Req() req: Request & { user: AuthedUser },
    @Body() body: CreateInviteDto
  ) {
    const me = req.user;
    const allowed = this.getAllowedTargets(me.role, me.level);

    if (allowed.levels.length === 0 && allowed.roles.length === 0) {
      return { ok: false, message: "Yetkisiz (davet oluşturamaz)" };
    }

    // Exactly one of targetLevel or targetRole must be provided
    if (!body.targetLevel && !body.targetRole) {
      return { ok: false, message: "targetLevel veya targetRole belirtilmeli" };
    }
    if (body.targetLevel && body.targetRole) {
      return { ok: false, message: "targetLevel ve targetRole aynı anda kullanılamaz" };
    }

    if (body.targetRole) {
      if (!allowed.roles.includes(body.targetRole)) {
        return { ok: false, message: `Bu rolü davet edemezsin: ${body.targetRole}` };
      }
    } else {
      if (!allowed.levels.includes(body.targetLevel!)) {
        const levelList = allowed.levels.join(", ");
        return { ok: false, message: `Sadece L${levelList} için davet oluşturabilirsin.` };
      }
    }

    // 3 kuralı: ADMIN ve REGIONAL_MANAGER için uygulanmaz
    if (me.role !== "ADMIN" && me.role !== "REGIONAL_MANAGER") {
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
        targetLevel: body.targetLevel ?? null,
        targetRole: (body.targetRole as any) ?? null,
        maxUses: body.maxUses ?? 3,
        note: body.note ?? null,
        expiresAt,
      },
      select: {
        token: true,
        targetLevel: true,
        targetRole: true,
        maxUses: true,
        usedCount: true,
        expiresAt: true,
      },
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
        targetRole: true,
        maxUses: true,
        usedCount: true,
        note: true,
      },
    });

    return {
      ok: true,
      items: items.map((x: typeof items[0]) => ({ ...x, link: `${base}/join?token=${x.token}` })),
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
