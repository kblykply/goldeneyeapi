import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ConfigService } from "@nestjs/config";
import { memoryStorage } from "multer";
import { createClient } from "@supabase/supabase-js";
import { IsOptional, IsString } from "class-validator";
import sharp from "sharp";
import { PrismaService } from "../prisma/prisma.service";
import { SkipAuth } from "../auth/skip-auth.decorator";
import { Roles } from "../auth/roles.decorator";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

class CreateNewsDto {
  @IsString()
  title: string;

  @IsString()
  source: string;

  @IsString()
  date: string;

  @IsString()
  link: string;
}

class UpdateNewsDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @IsString()
  link?: string;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@Controller("news")
export class NewsController {
  private supabase: ReturnType<typeof createClient>;
  private readonly _supabaseUrl: string;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    this._supabaseUrl = this.config.get<string>("SUPABASE_URL") ?? "";
    this.supabase = createClient(
      this._supabaseUrl,
      this.config.get<string>("SUPABASE_SERVICE_KEY") ?? "",
    );
  }

  private storagePathFromUrl(url: string): string {
    const prefix = `${this._supabaseUrl}/storage/v1/object/public/news/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : url;
  }

  private publicUrl(fileName: string): string {
    return `${this._supabaseUrl}/storage/v1/object/public/news/${fileName}`;
  }

  // ---------------------------------------------------------------------------
  // Public endpoint
  // ---------------------------------------------------------------------------

  @SkipAuth()
  @Get()
  async list() {
    const items = await this.prisma.news.findMany({
      orderBy: { createdAt: "desc" },
    });
    return { ok: true, data: { items, total: items.length } };
  }

  // ---------------------------------------------------------------------------
  // Admin endpoints — CRUD
  // ---------------------------------------------------------------------------

  @Roles("ADMIN")
  @Post()
  async create(@Body() dto: CreateNewsDto) {
    const news = await this.prisma.news.create({ data: dto });
    return { ok: true, data: news };
  }

  @Roles("ADMIN")
  @Patch(":id")
  async update(@Param("id") id: string, @Body() dto: UpdateNewsDto) {
    try {
      const news = await this.prisma.news.update({
        where: { id },
        data: {
          ...(dto.title !== undefined && { title: dto.title }),
          ...(dto.source !== undefined && { source: dto.source }),
          ...(dto.date !== undefined && { date: dto.date }),
          ...(dto.link !== undefined && { link: dto.link }),
        },
      });
      return { ok: true, data: news };
    } catch (e: any) {
      if (e?.code === "P2025") throw new NotFoundException("News not found");
      throw e;
    }
  }

  @Roles("ADMIN")
  @Delete(":id")
  async remove(@Param("id") id: string) {
    const existing = await this.prisma.news.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("News not found");

    if (existing.imageUrl) {
      await this.supabase.storage
        .from("news")
        .remove([this.storagePathFromUrl(existing.imageUrl)]);
    }

    await this.prisma.news.delete({ where: { id } });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Admin endpoints — image
  // ---------------------------------------------------------------------------

  @Roles("ADMIN")
  @Post(":id/image")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = ["image/png", "image/jpeg", "image/webp", "image/jpg"];
        if (allowed.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException("Only PNG, JPEG, WEBP images are allowed"),
            false,
          );
        }
      },
    }),
  )
  async uploadImage(@Param("id") id: string, @UploadedFile() file: any) {
    if (!file) throw new BadRequestException("No file provided");

    const existing = await this.prisma.news.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("News not found");

    if (existing.imageUrl) {
      await this.supabase.storage
        .from("news")
        .remove([this.storagePathFromUrl(existing.imageUrl)]);
    }

    const processed = await sharp(file.buffer)
      .resize(1400, 1400, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    const fileName = `${id}/${crypto.randomUUID()}.webp`;
    const { error } = await this.supabase.storage
      .from("news")
      .upload(fileName, processed, { contentType: "image/webp", upsert: false });

    if (error)
      throw new BadRequestException(`Storage upload failed: ${error.message}`);

    const news = await this.prisma.news.update({
      where: { id },
      data: { imageUrl: this.publicUrl(fileName) },
    });
    return { ok: true, data: news };
  }

  @Roles("ADMIN")
  @Delete(":id/image")
  async deleteImage(@Param("id") id: string) {
    const existing = await this.prisma.news.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("News not found");
    if (!existing.imageUrl) throw new BadRequestException("No image to delete");

    const { error } = await this.supabase.storage
      .from("news")
      .remove([this.storagePathFromUrl(existing.imageUrl)]);
    if (error)
      throw new BadRequestException(`Storage delete failed: ${error.message}`);

    const news = await this.prisma.news.update({
      where: { id },
      data: { imageUrl: null },
    });
    return { ok: true, data: news };
  }
}
