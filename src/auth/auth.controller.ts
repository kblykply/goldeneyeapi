import {
  Body,
  Controller,
  Post,
  UnauthorizedException,
  Request,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { IsString, Matches, MinLength } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { AuthedUser } from './auth.types';
import { SkipAuth } from './skip-auth.decorator';
import { Role } from '@prisma/client';

class LoginDto {
  @IsString()
  phoneE164!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

class RefreshDto {
  @IsString()
  refreshToken!: string;
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

@Controller('auth')
export class AuthController {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  private async issueTokens(userId: string) {
    const accessToken = this.jwtService.sign(
      { sub: userId },
      {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
        expiresIn: '2h',
      },
    );

    const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const stored = await this.prisma.refreshToken.create({
      data: { userId, expiresAt: refreshExpiresAt },
    });

    const refreshToken = this.jwtService.sign(
      { sub: userId, jti: stored.id },
      {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      },
    );

    return { accessToken, refreshToken };
  }

  @SkipAuth()
  @Post('login')
  async login(@Body() body: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { phoneE164: body.phoneE164 },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    // Lazy migration: plain text şifreyse hash'e çevir
    const isHashed =
      user.password.startsWith('$2b$') || user.password.startsWith('$2a$');
    let passwordMatch: boolean;
    if (isHashed) {
      passwordMatch = await bcrypt.compare(body.password, user.password);
    } else {
      passwordMatch = user.password === body.password;
      if (passwordMatch) {
        const hashed = await bcrypt.hash(body.password, 10);
        await this.prisma.user.update({
          where: { id: user.id },
          data: { password: hashed },
        });
      }
    }

    if (!passwordMatch) throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.issueTokens(user.id);

    return {
      ...tokens,
      user: {
        id: user.id,
        fullName: user.fullName,
        role: user.role,
        level: user.level,
        avatarUrl: user.avatarUrl ?? null,
      },
    };
  }

  @SkipAuth()
  @Post('refresh')
  async refresh(@Body() body: RefreshDto) {
    let payload: { sub: string; jti: string };
    try {
      payload = this.jwtService.verify(body.refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException(
        'Geçersiz veya süresi dolmuş refresh token',
      );
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { id: payload.jti },
    });

    if (!stored || stored.revokedAt || stored.expiresAt <= new Date()) {
      throw new UnauthorizedException(
        'Refresh token geçersiz ya da iptal edilmiş',
      );
    }

    // Rotate: eski token'ı iptal et
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    const tokens = await this.issueTokens(stored.userId);
    return tokens;
  }

  @Post('logout')
  async logout(
    @Request() req: { user: AuthedUser },
    @Body() body: { refreshToken?: string },
  ) {
    if (body.refreshToken) {
      try {
        const payload: { sub: string; jti: string } = this.jwtService.verify(
          body.refreshToken,
          { secret: this.config.get<string>('JWT_REFRESH_SECRET') },
        );
        await this.prisma.refreshToken.updateMany({
          where: { id: payload.jti, userId: req.user.id },
          data: { revokedAt: new Date() },
        });
      } catch {
        // Token geçersizse sessizce geç
      }
    }

    return { ok: true };
  }

  @SkipAuth()
  @Post('join')
  async join(@Body() body: JoinDto) {
    const now = new Date();

    const inv = await this.prisma.inviteToken.findUnique({
      where: { token: body.token },
      include: { inviter: { select: { id: true, role: true, level: true } } },
    });

    if (!inv) return { ok: false, message: 'Davet linki geçersiz' };
    if (inv.revokedAt) return { ok: false, message: 'Davet iptal edilmiş' };
    if (inv.expiresAt <= now)
      return { ok: false, message: 'Davet süresi dolmuş' };
    if (inv.usedCount >= inv.maxUses)
      return { ok: false, message: 'Davet hakkı dolmuş' };

    const inviter = inv.inviter;

    if (inv.targetRole) {
      if (inviter.role !== 'ADMIN') {
        return {
          ok: false,
          message: 'Bu davet kural dışı (sadece admin RM daveti oluşturabilir)',
        };
      }
    } else {
      const allowedTarget =
        inviter.role === 'ADMIN'
          ? 3
          : inviter.role === 'REGIONAL_MANAGER'
            ? 3
            : inviter.level === 3
              ? 2
              : inviter.level === 2
                ? 1
                : 0;

      if (inv.targetLevel !== allowedTarget) {
        return {
          ok: false,
          message: 'Bu davet kural dışı (hedef seviye uyuşmuyor)',
        };
      }
    }

    if (inviter.role !== 'ADMIN' && inviter.role !== 'REGIONAL_MANAGER') {
      const direct = await this.prisma.user.count({
        where: { leaderId: inviter.id },
      });
      if (direct >= 3)
        return { ok: false, message: 'Bu liderin ekibi dolu (3 kişi)' };
    }

    const exists = await this.prisma.user.findUnique({
      where: { phoneE164: body.phoneE164 },
    });
    if (exists) return { ok: false, message: 'Bu telefon zaten kayıtlı' };

    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          fullName: body.fullName,
          phoneE164: body.phoneE164,
          password: await bcrypt.hash(body.password, 10),
          role: inv.targetRole ?? Role.USER,
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
}
