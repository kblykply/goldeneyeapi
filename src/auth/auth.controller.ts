import { Body, Controller, Post, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IsString, Matches, MinLength } from "class-validator";

class LoginDto {
  @IsString()
  phoneE164!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

class JoinDto {
  @IsString()
  token!: string;

  @IsString()
  fullName!: string;

  @IsString()
  @Matches(/^\+\d{10,15}$/)
  phoneE164!: string;

  @IsString()
  @MinLength(4)
  password!: string;
}

@Controller("auth")
export class AuthController {
  constructor(private prisma: PrismaService) {}

  // ✅ Invite link join (NO GUARD)
  @Post("join")
  async join(@Body() body: JoinDto) {
    const now = new Date();

    const inv = await this.prisma.inviteToken.findUnique({
      where: { token: body.token },
      include: { inviter: { select: { id: true, role: true, level: true } } },
    });

    if (!inv) return { ok: false, message: "Davet linki geçersiz" };
    if (inv.revokedAt) return { ok: false, message: "Davet iptal edilmiş" };
    if (inv.expiresAt <= now) return { ok: false, message: "Davet süresi dolmuş" };
    if (inv.usedCount >= inv.maxUses) return { ok: false, message: "Davet hakkı dolmuş" };

    // enforce chain rule again (safety)
    const inviter = inv.inviter;
    const allowedTarget =
      inviter.role === "ADMIN" ? 3 : inviter.level === 3 ? 2 : inviter.level === 2 ? 1 : 0;

    if (inv.targetLevel !== allowedTarget) {
      return { ok: false, message: "Bu davet kural dışı (hedef seviye uyuşmuyor)" };
    }

    // 3 kuralı (inviter için)
    if (inviter.role !== "ADMIN") {
      const direct = await this.prisma.user.count({ where: { leaderId: inviter.id } });
      if (direct >= 3) return { ok: false, message: "Bu liderin ekibi dolu (3 kişi)" };
    }

    // unique phone
    const exists = await this.prisma.user.findUnique({ where: { phoneE164: body.phoneE164 } });
    if (exists) return { ok: false, message: "Bu telefon zaten kayıtlı" };

    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          fullName: body.fullName,
          phoneE164: body.phoneE164,
          password: body.password, // V1: plain. (V2: hash)
          role: "USER",
          level: inv.targetLevel,
          leaderId: inviter.id, // ✅ critical: link owner becomes leader
          isActive: true,
        },
        select: {
          id: true,
          fullName: true,
          phoneE164: true,
          role: true,
          level: true,
          leaderId: true,
          avatarUrl: true,
        },
      });

      await tx.inviteToken.update({
        where: { token: inv.token },
        data: { usedCount: { increment: 1 } },
      });

      return u;
    });

    return { ok: true, user };
  }

  @Post("login")
  async login(@Body() body: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { phoneE164: body.phoneE164 },
    });

    if (!user || user.password !== body.password) {
      throw new UnauthorizedException("Invalid credentials");
    }

    // DEV token format
    const accessToken = `dev:${user.id}`;

    return {
      accessToken,
      user: {
        id: user.id,
        fullName: user.fullName,
        role: user.role,
        level: user.level,
        avatarUrl: user.avatarUrl ?? null,
      },
    };
  }
}