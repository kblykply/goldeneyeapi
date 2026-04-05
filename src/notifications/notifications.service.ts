import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TeamService } from "../team/team.service";
import { NotificationType } from "@prisma/client";

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private team: TeamService,
  ) {}

  async create(data: {
    type: NotificationType;
    title: string;
    body: string;
    actorId: string;
    entityId?: string;
    entityType?: string;
  }) {
    return this.prisma.notification.create({ data });
  }

  private async subtreeFilter(userId: string, role: string) {
    if (role === "ADMIN") return {};
    if (role === "AUTHORITY") return { type: NotificationType.CONTRACT_PENDING_APPROVAL };
    const ids = Array.from(await this.team.getSubtreeIds(userId));
    return { actorId: { in: ids } };
  }

  async findForUser(userId: string, role: string) {
    const where = await this.subtreeFilter(userId, role);

    const items = await this.prisma.notification.findMany({
      where,
      include: {
        actor: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
        reads: { where: { userId }, select: { readAt: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return items.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      entityId: n.entityId,
      entityType: n.entityType,
      createdAt: n.createdAt,
      actor: n.actor,
      isRead: n.reads.length > 0,
    }));
  }

  async markAsRead(notificationId: string, userId: string) {
    await this.prisma.notificationRead.upsert({
      where: { notificationId_userId: { notificationId, userId } },
      update: {},
      create: { notificationId, userId },
    });
  }

  async markAllAsRead(userId: string, role: string) {
    const where = await this.subtreeFilter(userId, role);

    const notifs = await this.prisma.notification.findMany({
      where,
      select: { id: true },
    });

    if (notifs.length === 0) return;

    await this.prisma.notificationRead.createMany({
      data: notifs.map((n) => ({ notificationId: n.id, userId })),
      skipDuplicates: true,
    });
  }
}
