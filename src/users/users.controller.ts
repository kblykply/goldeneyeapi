import {
  BadRequestException,
  Controller,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { extname } from "path";
import { PrismaService } from "../prisma/prisma.service";
import { AuthGuard } from "../auth/auth.guard";
import { AuthedUser } from "../auth/auth.types";
import { Request } from "express";
import * as fs from "fs";

function ensureDir(path: string) {
  if (!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true });
}

const AVATAR_DIR = "uploads/avatars";

@Controller("users")
export class UsersController {
  constructor(private prisma: PrismaService) {}

  @Post("me/avatar")
  @UseGuards(AuthGuard)
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
}