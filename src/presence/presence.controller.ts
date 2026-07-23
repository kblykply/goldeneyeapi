import { Controller, Post, Req } from "@nestjs/common";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../cache/cache.service";
import { AuthedUser } from "../auth/auth.types";

// Online penceresi 2 dk (team.controller); 60 sn'lik throttle davranışı bozmaz
const HEARTBEAT_THROTTLE_MS = 60_000;

@Controller("presence")
export class PresenceController {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  @Post("heartbeat")
  async heartbeat(@Req() req: Request & { user: AuthedUser }) {
    const key = `hb:${req.user.id}`;
    if (this.cache.get(key)) return { ok: true };

    await this.prisma.user.update({
      where: { id: req.user.id },
      data: { lastSeenAt: new Date() },
    });
    this.cache.set(key, true, HEARTBEAT_THROTTLE_MS);

    return { ok: true };
  }
}
