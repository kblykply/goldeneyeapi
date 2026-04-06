import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "path";
import { PrismaService } from "../prisma/prisma.service";
import { TeamService } from "../team/team.service";
import { SmsService } from "../sms/sms.service";
import { AuthedUser } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { Request } from "express";
import { IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Min, Max, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { Role, NotificationType } from "@prisma/client";
import * as bcrypt from "bcrypt";
import * as fs from "fs";
import { DEFAULT_PASSWORD } from "../auth/auth.constants";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";

function ensureDir(path: string) {
  if (!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true });
}

const AVATAR_DIR = "uploads/avatars";

class ReassignItemDto {
  @IsString() subordinateId!: string;
  @IsString() newLeaderId!: string;
}

class ReassignAndDeleteDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReassignItemDto)
  assignments!: ReassignItemDto[];
}

class ChangeLevelSubDto {
  @IsString() subordinateId!: string;
  @IsString() newLeaderId!: string;
}

class ChangeLevelDto {
  @IsInt() @Min(1) @Max(3) newLevel!: number;
  @IsString() newLeaderId!: string;
  @IsEnum(["carry", "reassign"] as const) subordinateHandling!: "carry" | "reassign";
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChangeLevelSubDto)
  assignments?: ChangeLevelSubDto[];
}

class UpdateUserDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+\d{10,15}$/)
  phoneE164?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  level?: number;

  @IsOptional()
  @IsString()
  leaderId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(1)
  commissionRate?: number;
}

class CreateUserDto {
  @IsString()
  fullName!: string;

  @IsString()
  @Matches(/^\+\d{10,15}$/)
  phoneE164!: string;

  @IsEnum(Role)
  role!: Role;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  level?: number;

  @IsOptional()
  @IsString()
  leaderId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(1)
  commissionRate?: number;
}

@Controller("users")
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(
    private prisma: PrismaService,
    private teamService: TeamService,
    private smsService: SmsService,
    private audit: AuditService,
    private notifs: NotificationsService,
  ) {}

  @Post("me/avatar")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          ensureDir(AVATAR_DIR);
          cb(null, AVATAR_DIR);
        },
        filename: (_req, file, cb) => {
          const safeExt = extname(file.originalname).toLowerCase();
          const name = `avatar_${Date.now()}_${Math.random()
            .toString(16)
            .slice(2)}${safeExt}`;
          cb(null, name);
        },
      }),
      limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
      fileFilter: (_req, file, cb) => {
        const ok =
          file.mimetype === "image/png" ||
          file.mimetype === "image/jpeg" ||
          file.mimetype === "image/webp";
        cb(ok ? null : new BadRequestException("Only png/jpg/webp allowed"), ok);
      },
    })
  )
  async uploadAvatar(
    @UploadedFile() file: any,
    @Req() req: Request & { user: AuthedUser }
  ) {
    if (!file) throw new BadRequestException("Missing file");

    const urlPath = `/uploads/avatars/${file.filename}`;

    const user = await this.prisma.user.update({
      where: { id: req.user.id },
      data: { avatarUrl: urlPath },
      select: { id: true, fullName: true, avatarUrl: true },
    });

    await this.audit.log({
      action: 'USER_AVATAR_UPDATED',
      entityType: 'USER',
      entityId: user.id,
    });

    return { ok: true, user };
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles("ADMIN", "REGIONAL_MANAGER")
  async createUser(
    @Body() body: CreateUserDto,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const creator = req.user;

    // RM yalnızca USER, SPECIAL ve AGENCY oluşturabilir
    const bodyRole = body.role as string;
    if (
      creator.role === "REGIONAL_MANAGER" &&
      bodyRole !== "USER" &&
      bodyRole !== "SPECIAL" &&
      bodyRole !== "AGENCY"
    ) {
      throw new ForbiddenException("Regional Manager yalnızca USER, SPECIAL veya AGENCY oluşturabilir");
    }

    // Telefon unique kontrolü
    const exists = await this.prisma.user.findUnique({
      where: { phoneE164: body.phoneE164 },
    });
    if (exists) return { ok: false, message: "Bu telefon zaten kayıtlı" };

    let finalLeaderId: string | null = creator.id;
    let finalLevel = body.level ?? 0;

    if (bodyRole === "USER") {
      if (!body.level || body.level < 1 || body.level > 3) {
        return { ok: false, message: "USER rolü için level (1-3) zorunlu" };
      }

      if (body.level === 3) {
        if (creator.role === "ADMIN") {
          // ADMIN oluşturuyorsa hangi RM'nin altına ekleneceği seçilmeli
          if (!body.leaderId) {
            return { ok: false, message: "lvl 3 için Regional Manager seçilmeli" };
          }
          const leader = await this.prisma.user.findUnique({
            where: { id: body.leaderId },
            select: { id: true, role: true },
          });
          if (!leader || (leader.role !== "REGIONAL_MANAGER" && (leader.role as string) !== "AGENCY" && (leader.role as string) !== "REGIONAL_LEADER")) {
            return { ok: false, message: "Seçilen lider REGIONAL_MANAGER, REGIONAL_LEADER veya AGENCY olmalı" };
          }
          finalLeaderId = body.leaderId;
        } else {
          // RM oluşturuyorsa direkt kendi altına
          finalLeaderId = creator.id;
        }
      } else {
        // level 2 veya 1: leaderId seçilmeli
        if (!body.leaderId) {
          return { ok: false, message: "Bu seviye için lider seçilmeli" };
        }

        const leaderLevel = body.level === 2 ? 3 : 2;

        // Lider varlık ve seviye kontrolü
        const leader = await this.prisma.user.findUnique({
          where: { id: body.leaderId },
          select: { id: true, level: true, role: true },
        });

        if (!leader || leader.level !== leaderLevel) {
          return {
            ok: false,
            message: `Seçilen lider lvl ${leaderLevel} olmalı`,
          };
        }

        // RM için lider kendi subtree'sinde olmalı (ADMIN tüm sistemi yönetir)
        if (creator.role !== "ADMIN") {
          const subtree = await this.teamService.getSubtreeIds(creator.id);
          if (!subtree.has(body.leaderId)) {
            return { ok: false, message: "Seçilen lider sizin ekibinizde değil" };
          }
        }

        // 3 kişi sınırı kontrolü
        const directCount = await this.prisma.user.count({
          where: { leaderId: body.leaderId },
        });
        if (directCount >= 3) {
          return { ok: false, message: "Bu liderin ekibi dolu (3 kişi)" };
        }

        finalLeaderId = body.leaderId;
      }
    } else if ((body.role as string) === "SPECIAL") {
      if (!body.commissionRate) {
        return { ok: false, message: "SPECIAL rolü için komisyon oranı gerekli" };
      }
      finalLevel = 0;
      finalLeaderId = creator.id;
    } else {
      // ADMIN, REGIONAL_MANAGER, AGENCY: level = 0, leaderId = creator
      finalLevel = 0;
      finalLeaderId = creator.id;
    }

    const user = await this.prisma.user.create({
      data: {
        fullName: body.fullName,
        phoneE164: body.phoneE164,
        password: await bcrypt.hash(DEFAULT_PASSWORD, 10),
        role: body.role,
        level: finalLevel,
        leaderId: finalLeaderId,
        isActive: true,
        ...(bodyRole === "SPECIAL" && body.commissionRate
          ? { commissionRate: body.commissionRate }
          : {}),
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

    this.smsService.sendWelcomeWhatsApp(user.phoneE164, user.fullName).catch((err) => this.logger.warn(`Welcome WhatsApp failed: ${err?.message}`));

    await this.audit.log({
      action: 'USER_CREATED',
      entityType: 'USER',
      entityId: user.id,
      meta: { role: user.role, level: user.level },
    });

    return { ok: true, user };
  }

  @Get("candidates")
  @UseGuards(RolesGuard)
  @Roles("ADMIN", "REGIONAL_MANAGER")
  async getCandidates(
    @Query("level") levelStr: string,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const level = parseInt(levelStr, 10);
    if (level !== 1 && level !== 2 && level !== 3) {
      return { ok: false, message: "level 1, 2 veya 3 olmalı" };
    }

    // level=3 → lider REGIONAL_MANAGER (role bazlı)
    // level=2 → lider level=3 USER
    // level=1 → lider level=2 USER
    let potentialLeaders: { id: string; fullName: string; level: number }[];

    if (req.user.role === "ADMIN") {
      // ADMIN tüm sistemi yönetir — subtree filtresi uygulanmaz
      // (eski kullanıcılarda leaderId null olabileceğinden subtree traversal çalışmaz)
      if (level === 3) {
        potentialLeaders = await this.prisma.user.findMany({
          where: { isActive: true, role: { in: ["REGIONAL_MANAGER", "AGENCY", "REGIONAL_LEADER"] as any[] } },
          select: { id: true, fullName: true, level: true },
        });
      } else {
        potentialLeaders = await this.prisma.user.findMany({
          where: { isActive: true, role: "USER", level: level === 1 ? 2 : 3 },
          select: { id: true, fullName: true, level: true },
        });
      }
    } else {
      // RM kendi subtree'sindeki kullanıcıları görebilir
      const subtreeIds = await this.teamService.getSubtreeIds(req.user.id);
      const leaderLevel = level === 1 ? 2 : 3;
      potentialLeaders = await this.prisma.user.findMany({
        where: { id: { in: Array.from(subtreeIds) }, isActive: true, role: "USER", level: leaderLevel },
        select: { id: true, fullName: true, level: true },
      });
    }

    const slotCounts = await this.prisma.user.groupBy({
      by: ["leaderId"],
      where: { leaderId: { in: potentialLeaders.map((u) => u.id) } },
      _count: { id: true },
    });
    const slotMap = new Map(slotCounts.map((r) => [r.leaderId, r._count.id]));

    const candidates = potentialLeaders.map((u) => ({
      ...u,
      usedSlots: slotMap.get(u.id) ?? 0,
    }));

    return {
      ok: true,
      candidates: level === 3 ? candidates : candidates.filter((c) => c.usedSlots < 3),
    };
  }

  @Patch(":id")
  @UseGuards(RolesGuard)
  @Roles("ADMIN")
  async updateUser(
    @Param("id") id: string,
    @Body() body: UpdateUserDto,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const patch = Object.fromEntries(
      Object.entries({
        fullName: body.fullName,
        phoneE164: body.phoneE164,
        isActive: body.isActive,
        role: body.role,
        level: body.level,
        leaderId: body.leaderId,
        commissionRate: body.commissionRate,
      }).filter(([, v]) => v !== undefined)
    );

    try {
      const user = await this.prisma.user.update({
        where: { id },
        data: patch,
        select: {
          id: true,
          fullName: true,
          phoneE164: true,
          role: true,
          level: true,
          leaderId: true,
          isActive: true,
          avatarUrl: true,
        },
      });
      await this.audit.log({
        action: 'USER_UPDATED',
        entityType: 'USER',
        entityId: user.id,
        meta: { fields: Object.keys(patch) },
      });

      // Lider veya seviye değişikliği bildirimi
      if (body.leaderId !== undefined || body.level !== undefined) {
        const leaderName = body.leaderId
          ? await this.prisma.user.findUnique({ where: { id: body.leaderId }, select: { fullName: true } }).then((l) => l?.fullName)
          : undefined;
        const notifType = body.level !== undefined ? NotificationType.USER_LEVEL_CHANGED : NotificationType.USER_LEADER_CHANGED;
        const title = body.level !== undefined ? "Seviyeniz Güncellendi" : "Lideriniz Değiştirildi";
        const bodyText = body.level !== undefined
          ? `Seviyeniz ${body.level} olarak güncellendi${leaderName ? `, yeni lideriniz: ${leaderName}` : ""}.`
          : `Lideriniz değiştirildi${leaderName ? `: ${leaderName}` : ""}.`;
        this.notifs.create({ type: notifType, title, body: bodyText, actorId: req.user.id, recipientId: id, entityId: id, entityType: "USER" }).catch(() => {});
      }

      return { ok: true, user };
    } catch (e: any) {
      if (e.code === "P2025") return { ok: false, message: "Kullanıcı bulunamadı" };
      if (e.code === "P2002") return { ok: false, message: "Bu telefon numarası zaten kayıtlı" };
      throw e;
    }
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles("ADMIN")
  async deleteUser(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthedUser }
  ) {
    if (req.user.id === id) {
      return { ok: false, message: "Kendinizi silemezsiniz" };
    }

    const activeDownline = await this.prisma.user.findMany({
      where: { leaderId: id, isActive: true },
      select: { id: true, fullName: true, level: true },
    });
    if (activeDownline.length > 0) {
      return { ok: false, requiresReassign: true, downline: activeDownline };
    }

    try {
      await this.prisma.user.update({
        where: { id },
        data: { isActive: false },
      });
      await this.audit.log({
        action: 'USER_DEACTIVATED',
        entityType: 'USER',
        entityId: id,
      });
      return { ok: true };
    } catch (e: any) {
      if (e.code === "P2025") return { ok: false, message: "Kullanıcı bulunamadı" };
      throw e;
    }
  }

  @Post(":id/reassign-and-delete")
  @UseGuards(RolesGuard)
  @Roles("ADMIN")
  async reassignAndDelete(
    @Param("id") id: string,
    @Body() body: ReassignAndDeleteDto,
    @Req() req: Request & { user: AuthedUser }
  ) {
    if (req.user.id === id) return { ok: false, message: "Kendinizi silemezsiniz" };

    const actualDownline = await this.prisma.user.findMany({
      where: { leaderId: id, isActive: true },
      select: { id: true },
    });
    const downlineSet = new Set(actualDownline.map((u) => u.id));

    if (body.assignments.length !== actualDownline.length) {
      return { ok: false, message: "Tüm alt kullanıcılar atanmalı" };
    }
    for (const { subordinateId } of body.assignments) {
      if (!downlineSet.has(subordinateId)) return { ok: false, message: "Geçersiz alt kullanıcı" };
    }

    const targetLeaderIds = [...new Set(body.assignments.map((a) => a.newLeaderId))];
    if (targetLeaderIds.includes(id)) {
      return { ok: false, message: "Silinen kullanıcı yeni lider olamaz" };
    }

    const targetLeaders = await this.prisma.user.findMany({
      where: { id: { in: targetLeaderIds }, isActive: true },
      select: { id: true, level: true, role: true },
    });
    if (targetLeaders.length !== targetLeaderIds.length) {
      return { ok: false, message: "Bir veya daha fazla hedef lider bulunamadı" };
    }

    const lvl2LeaderIds = targetLeaders
      .filter((l) => l.role === Role.USER && l.level === 2)
      .map((l) => l.id);

    if (lvl2LeaderIds.length > 0) {
      const currentCounts = await this.prisma.user.groupBy({
        by: ["leaderId"],
        where: { leaderId: { in: lvl2LeaderIds }, isActive: true },
        _count: { id: true },
      });
      const currentCountMap = new Map(currentCounts.map((r) => [r.leaderId as string, r._count.id]));

      const addedMap = new Map<string, number>();
      for (const { newLeaderId } of body.assignments) {
        addedMap.set(newLeaderId, (addedMap.get(newLeaderId) ?? 0) + 1);
      }

      for (const lid of lvl2LeaderIds) {
        const current = currentCountMap.get(lid) ?? 0;
        const added = addedMap.get(lid) ?? 0;
        if (current + added > 3) {
          return { ok: false, message: "Seçilen lider kapasitesi dolu" };
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await Promise.all(
        body.assignments.map(({ subordinateId, newLeaderId }) =>
          tx.user.update({ where: { id: subordinateId }, data: { leaderId: newLeaderId } })
        )
      );
      await tx.user.update({ where: { id }, data: { isActive: false } });
      await this.audit.logWithTx(tx, {
        action: "USER_REASSIGN_AND_DELETE",
        entityType: "USER",
        entityId: id,
        meta: { assignments: body.assignments },
      });
    });

    return { ok: true };
  }

  @Post(":id/change-level")
  @UseGuards(RolesGuard)
  @Roles("ADMIN")
  async changeLevel(
    @Param("id") id: string,
    @Body() body: ChangeLevelDto,
    @Req() req: Request & { user: AuthedUser }
  ) {
    if (req.user.id === id) return { ok: false, message: "Kendiniz için bu işlem yapılamaz" };

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, level: true, isActive: true },
    });
    if (!user || !user.isActive) return { ok: false, message: "Kullanıcı bulunamadı" };

    // Yeni lideri doğrula
    const newLeader = await this.prisma.user.findUnique({
      where: { id: body.newLeaderId },
      select: { id: true, fullName: true, role: true, level: true, isActive: true },
    });
    if (!newLeader || !newLeader.isActive) return { ok: false, message: "Hedef lider bulunamadı" };

    const validLeader =
      body.newLevel === 3
        ? ([Role.REGIONAL_MANAGER, Role.AGENCY, Role.REGIONAL_LEADER] as Role[]).includes(newLeader.role)
        : newLeader.role === Role.USER && newLeader.level === body.newLevel + 1;
    if (!validLeader) return { ok: false, message: "Geçersiz lider seçimi" };

    // Yeni lider slot kapasitesi kontrolü (lvl3 için sınırsız)
    if (body.newLevel !== 3) {
      const slotCount = await this.prisma.user.count({
        where: { leaderId: body.newLeaderId, isActive: true, id: { not: id } },
      });
      if (slotCount >= 3) return { ok: false, message: "Seçilen liderin kapasitesi dolu" };
    }

    // Direkt alt kullanıcılar
    const subordinates = await this.prisma.user.findMany({
      where: { leaderId: id, isActive: true },
      select: { id: true, level: true },
    });

    // Alt kullanıcı yoksa — basit güncelleme
    if (subordinates.length === 0) {
      await this.prisma.user.update({ where: { id }, data: { level: body.newLevel, leaderId: body.newLeaderId } });
      await this.audit.log({ action: "USER_LEVEL_CHANGED", entityType: "USER", entityId: id, meta: { oldLevel: user.level, newLevel: body.newLevel } });
      this.notifs.create({
        type: NotificationType.USER_LEVEL_CHANGED,
        title: "Seviyeniz Güncellendi",
        body: `Seviyeniz ${user.level} → ${body.newLevel} olarak güncellendi. Yeni lideriniz: ${newLeader!.fullName}.`,
        actorId: req.user.id,
        recipientId: id,
        entityId: id,
        entityType: "USER",
      }).catch(() => {});
      return { ok: true };
    }

    // Alt kullanıcı var — mod gerekli
    if (body.subordinateHandling === "carry") {
      if (body.newLevel < 2) return { ok: false, message: "Bu seviye için 'beraberinde taşı' geçerli değil" };
      const subNewLevel = body.newLevel - 1;
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id }, data: { level: body.newLevel, leaderId: body.newLeaderId } });
        await Promise.all(
          subordinates.map((s) => tx.user.update({ where: { id: s.id }, data: { level: subNewLevel } }))
        );
        await this.audit.logWithTx(tx, {
          action: "USER_LEVEL_CHANGED_CARRY",
          entityType: "USER",
          entityId: id,
          meta: { oldLevel: user.level, newLevel: body.newLevel, subNewLevel, subordinateCount: subordinates.length },
        });
      });
      // Kullanıcıya bildirim
      this.notifs.create({
        type: NotificationType.USER_LEVEL_CHANGED,
        title: "Seviyeniz Güncellendi",
        body: `Seviyeniz ${user.level} → ${body.newLevel} olarak güncellendi. Yeni lideriniz: ${newLeader!.fullName}.`,
        actorId: req.user.id, recipientId: id, entityId: id, entityType: "USER",
      }).catch(() => {});
      // Alt kullanıcılara bildirim
      Promise.all(subordinates.map((s) =>
        this.notifs.create({
          type: NotificationType.USER_LEVEL_CHANGED,
          title: "Seviyeniz Güncellendi",
          body: `Seviyeniz ${s.level} → ${subNewLevel} olarak güncellendi.`,
          actorId: req.user.id, recipientId: s.id, entityId: s.id, entityType: "USER",
        })
      )).catch(() => {});
      return { ok: true };
    }

    // subordinateHandling === "reassign"
    const assignments = body.assignments ?? [];
    const subordinateIds = new Set(subordinates.map((s) => s.id));

    if (assignments.length !== subordinates.length) return { ok: false, message: "Tüm alt kullanıcılar atanmalı" };
    for (const { subordinateId } of assignments) {
      if (!subordinateIds.has(subordinateId)) return { ok: false, message: "Geçersiz alt kullanıcı" };
    }

    const targetLeaderIds = [...new Set(assignments.map((a) => a.newLeaderId))];
    if (targetLeaderIds.includes(id)) return { ok: false, message: "Kullanıcı kendi alt kullanıcısının lideri olamaz" };

    const targetLeaders = await this.prisma.user.findMany({
      where: { id: { in: targetLeaderIds }, isActive: true },
      select: { id: true, fullName: true, level: true, role: true },
    });
    if (targetLeaders.length !== targetLeaderIds.length) return { ok: false, message: "Bir veya daha fazla hedef lider bulunamadı" };

    // Slot kapasitesi kontrolü (lvl2 liderler için)
    const lvl2LeaderIds = targetLeaders.filter((l) => l.role === Role.USER && l.level === 2).map((l) => l.id);
    if (lvl2LeaderIds.length > 0) {
      const currentCounts = await this.prisma.user.groupBy({
        by: ["leaderId"],
        where: { leaderId: { in: lvl2LeaderIds }, isActive: true },
        _count: { id: true },
      });
      const currentCountMap = new Map(currentCounts.map((r) => [r.leaderId as string, r._count.id]));
      const addedMap = new Map<string, number>();
      for (const { newLeaderId } of assignments) {
        addedMap.set(newLeaderId, (addedMap.get(newLeaderId) ?? 0) + 1);
      }
      for (const lid of lvl2LeaderIds) {
        const current = currentCountMap.get(lid) ?? 0;
        const added = addedMap.get(lid) ?? 0;
        if (current + added > 3) return { ok: false, message: "Seçilen lider kapasitesi dolu" };
      }
    }

    const leaderNameMap = new Map(targetLeaders.map((l) => [l.id, l.fullName]));

    await this.prisma.$transaction(async (tx) => {
      await Promise.all(
        assignments.map(({ subordinateId, newLeaderId }) =>
          tx.user.update({ where: { id: subordinateId }, data: { leaderId: newLeaderId } })
        )
      );
      await tx.user.update({ where: { id }, data: { level: body.newLevel, leaderId: body.newLeaderId } });
      await this.audit.logWithTx(tx, {
        action: "USER_LEVEL_CHANGED_REASSIGN",
        entityType: "USER",
        entityId: id,
        meta: { oldLevel: user.level, newLevel: body.newLevel, assignments },
      });
    });

    // Kullanıcıya bildirim
    this.notifs.create({
      type: NotificationType.USER_LEVEL_CHANGED,
      title: "Seviyeniz Güncellendi",
      body: `Seviyeniz ${user.level} → ${body.newLevel} olarak güncellendi. Yeni lideriniz: ${newLeader!.fullName}.`,
      actorId: req.user.id, recipientId: id, entityId: id, entityType: "USER",
    }).catch(() => {});
    // Her alt kullanıcıya lider değişikliği bildirimi
    Promise.all(assignments.map(({ subordinateId, newLeaderId }) =>
      this.notifs.create({
        type: NotificationType.USER_LEADER_CHANGED,
        title: "Lideriniz Değiştirildi",
        body: `Lideriniz değiştirildi. Yeni lideriniz: ${leaderNameMap.get(newLeaderId) ?? "bilinmiyor"}.`,
        actorId: req.user.id, recipientId: subordinateId, entityId: subordinateId, entityType: "USER",
      })
    )).catch(() => {});

    return { ok: true };
  }
}
