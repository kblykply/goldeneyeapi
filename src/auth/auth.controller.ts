import { Body, Controller, Post, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IsString, Matches, MinLength } from "class-validator";
import * as bcrypt from "bcrypt";

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

    if (inv.targetRole) {
      // RM daveti: sadece ADMIN oluşturabilir
      if (inviter.role !== "ADMIN") {
        return { ok: false, message: "Bu davet kural dışı (sadece admin RM daveti oluşturabilir)" };
      }
    } else {
      const allowedTarget =
        inviter.role === "ADMIN" ? 3
        : inviter.role === "REGIONAL_MANAGER" ? 3
        : inviter.level === 3 ? 2
        : inviter.level === 2 ? 1
        : 0;

      if (inv.targetLevel !== allowedTarget) {
        return { ok: false, message: "Bu davet kural dışı (hedef seviye uyuşmuyor)" };
      }
    }

    // 3 kuralı: ADMIN ve REGIONAL_MANAGER için uygulanmaz
    if (inviter.role !== "ADMIN" && inviter.role !== "REGIONAL_MANAGER") {
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
          password: await bcrypt.hash(body.password, 10),
          role: (inv.targetRole as any) ?? "USER",
          level: inv.targetRole ? 0 : (inv.targetLevel ?? 1),
          leaderId: inviter.id,
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

    if (!user) throw new UnauthorizedException("Invalid credentials");

    // Lazy migration: plain text şifreyse hash'e çevir
    const isHashed = user.password.startsWith("$2b$") || user.password.startsWith("$2a$");
    let passwordMatch: boolean;
    if (isHashed) {
      passwordMatch = await bcrypt.compare(body.password, user.password);
    } else {
      passwordMatch = user.password === body.password;
      if (passwordMatch) {
        const hashed = await bcrypt.hash(body.password, 10);
        await this.prisma.user.update({ where: { id: user.id }, data: { password: hashed } });
      }
    }

    if (!passwordMatch) throw new UnauthorizedException("Invalid credentials");

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