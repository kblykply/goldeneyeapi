import { Controller, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuthGuard } from "../auth/auth.guard";
import { AuthedUser } from "../auth/auth.types";

@Controller("presence")
@UseGuards(AuthGuard)
export class PresenceController {
  constructor(private prisma: PrismaService) {}

  @Post("heartbeat")
  async heartbeat(@Req() req: Request & { user: AuthedUser }) {
    await this.prisma.user.update({
      where: { id: req.user.id },
      data: { lastSeenAt: new Date() },
    });

    return { ok: true };
  }
}