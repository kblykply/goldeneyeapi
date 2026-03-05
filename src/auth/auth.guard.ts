import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuthedUser } from "./auth.types";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const auth = req.headers["authorization"];
    if (!auth?.startsWith("Bearer ")) throw new UnauthorizedException("Missing token");

    // DEV token format: "dev:<userId>"
    const token = auth.slice("Bearer ".length).trim();
    if (!token.startsWith("dev:")) throw new UnauthorizedException("Invalid token");

    const userId = token.slice("dev:".length);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("User not found");

    req.user = { id: user.id, fullName: user.fullName, role: user.role as any, level: user.level };
    return true;
  }
}