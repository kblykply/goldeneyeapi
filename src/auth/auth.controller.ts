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
import { IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { AuthedUser } from './auth.types';
import { SkipAuth } from './skip-auth.decorator';
import { DEFAULT_PASSWORD } from './auth.constants';
import { AuditService } from '../audit/audit.service';

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

class CheckPhoneDto {
  @IsString()
  phoneE164!: string;
}

class SetInitialPasswordDto {
  @IsString()
  phoneE164!: string;

  @IsString()
  @MinLength(4)
  newPassword!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
    private audit: AuditService,
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
  @Post('check-phone')
  async checkPhone(@Body() body: CheckPhoneDto) {
    const user = await this.prisma.user.findUnique({
      where: { phoneE164: body.phoneE164 },
      select: { password: true },
    });

    if (!user) return { ok: true, exists: false };

    const firstLogin = await bcrypt.compare(DEFAULT_PASSWORD, user.password);
    return { ok: true, exists: true, firstLogin };
  }

  @SkipAuth()
  @Post('set-initial-password')
  async setInitialPassword(@Body() body: SetInitialPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { phoneE164: body.phoneE164 },
    });

    if (!user) throw new UnauthorizedException('Kullanıcı bulunamadı');

    const isDefault = await bcrypt.compare(DEFAULT_PASSWORD, user.password);
    if (!isDefault) {
      return { ok: false, message: 'Şifre zaten değiştirilmiş' };
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: await bcrypt.hash(body.newPassword, 10) },
    });

    const tokens = await this.issueTokens(user.id);

    await this.audit.log({
      action: 'PASSWORD_INITIALIZED',
      entityType: 'USER',
      entityId: user.id,
    });

    return {
      ok: true,
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

    await this.audit.log({
      action: 'LOGIN',
      entityType: 'USER',
      entityId: user.id,
      meta: { role: user.role },
    });

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

    await this.audit.log({
      action: 'TOKEN_REFRESHED',
      entityType: 'USER',
      entityId: stored.userId,
    });

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

    await this.audit.log({
      action: 'LOGOUT',
      entityType: 'USER',
      entityId: req.user.id,
    });

    return { ok: true };
  }
}
