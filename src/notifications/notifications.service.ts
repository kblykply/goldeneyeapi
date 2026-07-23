import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TeamService } from "../team/team.service";
import { NotificationType } from "@prisma/client";

@Injectable()
export class NotificationsService {
  // Restart sonrası eski ETag'lerin yanlışlıkla 304 almasını önler
  private readonly bootId = Date.now().toString(36);
  private globalVersion = 0;
  private readonly readVersions = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private team: TeamService,
  ) {}

  etagFor(userId: string) {
    // userId ETag'e dahil: aynı tarayıcıda kullanıcı değişince eski kullanıcının
    // cache'lenmiş gövdesi 304 ile servis edilemez
    return `W/"n:${this.bootId}:${userId}:${this.globalVersion}:${this.readVersions.get(userId) ?? 0}"`;
  }

  private bumpReadVersion(userId: string) {
    this.readVersions.set(userId, (this.readVersions.get(userId) ?? 0) + 1);
  }

  async create(data: {
    type: NotificationType;
    title: string;
    body: string;
    actorId: string;
    recipientId?: string;
    entityId?: string;
    entityType?: string;
  }) {
    const created = await this.prisma.notification.create({ data });
    this.globalVersion++;
    return created;
  }

  private async broadcastFilter(userId: string, role: string) {
    if (role === "ADMIN") return {};
    if (role === "AUTHORITY") return { type: NotificationType.CONTRACT_PENDING_APPROVAL };
    const ids = Array.from(await this.team.getSubtreeIds(userId));
    return { actorId: { in: ids } };
  }

  private async userNotifWhere(userId: string, role: string) {
    const broadcast = await this.broadcastFilter(userId, role);
    return { OR: [{ recipientId: userId }, { recipientId: null, ...broadcast }] };
  }

  async findForUser(userId: string, role: string) {
    const where = await this.userNotifWhere(userId, role);

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
    this.bumpReadVersion(userId);
  }

  async markAllAsRead(userId: string, role: string) {
    const where = await this.userNotifWhere(userId, role);

    const notifs = await this.prisma.notification.findMany({
      where,
      select: { id: true },
      take: 200,
    });

    if (notifs.length === 0) return;

    await this.prisma.notificationRead.createMany({
      data: notifs.map((n) => ({ notificationId: n.id, userId })),
      skipDuplicates: true,
    });
    this.bumpReadVersion(userId);
  }
}
