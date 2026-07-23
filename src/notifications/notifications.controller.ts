import { Controller, Get, Param, Post, Req, Res } from "@nestjs/common";
import { Request } from "express";
import type { Response } from "express";
import { AuthedUser } from "../auth/auth.types";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
export class NotificationsController {
  constructor(private notifs: NotificationsService) {}

  @Get()
  async list(
    @Req() req: Request & { user: AuthedUser },
    @Res({ passthrough: true }) res: Response,
  ) {
    const me = req.user;
    const etag = this.notifs.etagFor(me.id);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");

    // Değişiklik yoksa DB'ye hiç gitmeden 304 dön
    if (req.headers["if-none-match"] === etag) {
      res.status(304);
      return;
    }

    const items = await this.notifs.findForUser(me.id, me.role);
    return { ok: true, items };
  }

  @Post("read-all")
  async markAllRead(@Req() req: Request & { user: AuthedUser }) {
    await this.notifs.markAllAsRead(req.user.id, req.user.role);
    return { ok: true };
  }

  @Post(":id/read")
  async markRead(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthedUser }
  ) {
    await this.notifs.markAsRead(id, req.user.id);
    return { ok: true };
  }
}
