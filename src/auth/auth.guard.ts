import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../cache/cache.service";
import { AuthedUser } from "./auth.types";
import { SKIP_AUTH_KEY } from "./skip-auth.decorator";

const AUTH_USER_TTL_MS = 60_000;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
    private prisma: PrismaService,
    private cache: CacheService,
    private reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (skip) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const auth = req.headers["authorization"];
    if (!auth?.startsWith("Bearer ")) throw new UnauthorizedException("Missing token");

    const token = auth.slice("Bearer ".length).trim();

    let payload: { sub: string };
    try {
      payload = this.jwtService.verify(token, {
        secret: this.config.get<string>("JWT_ACCESS_SECRET"),
      });
    } catch {
      throw new UnauthorizedException("Geçersiz veya süresi dolmuş token");
    }

    const user = await this.cache.getOrSet(`authuser:${payload.sub}`, AUTH_USER_TTL_MS, () =>
      this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, fullName: true, role: true, level: true, isActive: true },
      }),
    );
    if (!user || !user.isActive) throw new UnauthorizedException("Kullanıcı bulunamadı");

    req.user = { id: user.id, fullName: user.fullName, role: user.role as any, level: user.level };
    return true;
  }
}
