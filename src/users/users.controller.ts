import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
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
import { AuthedUser } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { Request } from "express";
import { IsEnum, IsInt, IsOptional, IsString, Matches, Min, Max, MinLength } from "class-validator";
import { Role } from "@prisma/client";
import * as bcrypt from "bcrypt";
import * as fs from "fs";

function ensureDir(path: string) {
  if (!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true });
}

const AVATAR_DIR = "uploads/avatars";

class CreateUserDto {
  @IsString()
  fullName!: string;

  @IsString()
  @Matches(/^\+\d{10,15}$/)
  phoneE164!: string;

  @IsString()
  @MinLength(4)
  password!: string;

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
}

@Controller("users")
export class UsersController {
  constructor(
    private prisma: PrismaService,
    private teamService: TeamService,
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

    // RM sadece USER oluşturabilir
    if (creator.role === "REGIONAL_MANAGER" && body.role !== "USER") {
      throw new ForbiddenException("Regional Manager yalnızca USER oluşturabilir");
    }

    // Telefon unique kontrolü
    const exists = await this.prisma.user.findUnique({
      where: { phoneE164: body.phoneE164 },
    });
    if (exists) return { ok: false, message: "Bu telefon zaten kayıtlı" };

    let finalLeaderId: string | null = creator.id;
    let finalLevel = body.level ?? 0;

    if (body.role === "USER") {
      if (!body.level || body.level < 1 || body.level > 3) {
        return { ok: false, message: "USER rolü için level (1-3) zorunlu" };
      }

      if (body.level === 3) {
        // Direkt creator altına
        finalLeaderId = creator.id;
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

        // Lider creator'ın subtree'sinde mi?
        const subtree = await this.teamService.getSubtreeIds(creator.id);
        if (!subtree.has(body.leaderId)) {
          return { ok: false, message: "Seçilen lider sizin ekibinizde değil" };
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
    } else {
      // ADMIN veya REGIONAL_MANAGER oluşturuluyorsa level = 0, leaderId = creator
      finalLevel = 0;
      finalLeaderId = creator.id;
    }

    const user = await this.prisma.user.create({
      data: {
        fullName: body.fullName,
        phoneE164: body.phoneE164,
        password: await bcrypt.hash(body.password, 10),
        role: body.role,
        level: finalLevel,
        leaderId: finalLeaderId,
        isActive: true,
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
    if (level !== 1 && level !== 2) {
      return { ok: false, message: "level 1 veya 2 olmalı" };
    }

    // Yeni user'ın level'ı = 1 → lider level = 2
    // Yeni user'ın level'ı = 2 → lider level = 3
    const leaderLevel = level === 1 ? 2 : 3;

    const subtreeIds = await this.teamService.getSubtreeIds(req.user.id);

    const potentialLeaders = await this.prisma.user.findMany({
      where: {
        id: { in: Array.from(subtreeIds) },
        level: leaderLevel,
        isActive: true,
      },
      select: { id: true, fullName: true, level: true },
    });

    const candidates = await Promise.all(
      potentialLeaders.map(async (u) => {
        const usedSlots = await this.prisma.user.count({
          where: { leaderId: u.id },
        });
        return { ...u, usedSlots };
      })
    );

    return {
      ok: true,
      candidates: candidates.filter((c) => c.usedSlots < 3),
    };
  }
}
