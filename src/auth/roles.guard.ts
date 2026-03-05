import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "./roles.decorator";
import { Request } from "express";
import { AuthedUser } from "./auth.types";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const user = req.user;
    if (!user) throw new ForbiddenException("No user");
    if (!roles.includes(user.role)) throw new ForbiddenException("Forbidden");
    return true;
  }
}