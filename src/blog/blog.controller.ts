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
  Query,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ConfigService } from "@nestjs/config";
import { memoryStorage } from "multer";
import { createClient } from "@supabase/supabase-js";
import { IsOptional, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import sharp from "sharp";
import { PrismaService } from "../prisma/prisma.service";
import { SkipAuth } from "../auth/skip-auth.decorator";
import { Roles } from "../auth/roles.decorator";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

class TranslationDto {
  @IsString() title: string;
  @IsString() excerpt: string;
  @IsString() content: string;
  @IsString() category: string;
}

class CreateBlogPostDto {
  @IsString() date: string;
  @ValidateNested() @Type(() => TranslationDto) tr: TranslationDto;
  @ValidateNested() @Type(() => TranslationDto) en: TranslationDto;
}

class UpdateBlogPostDto {
  @IsOptional() @IsString() date?: string;
  @IsOptional() @ValidateNested() @Type(() => TranslationDto) tr?: TranslationDto;
  @IsOptional() @ValidateNested() @Type(() => TranslationDto) en?: TranslationDto;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@Controller("blog")
export class BlogController {
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
    const prefix = `${this._supabaseUrl}/storage/v1/object/public/blog/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : url;
  }

  private publicUrl(fileName: string): string {
    return `${this._supabaseUrl}/storage/v1/object/public/blog/${fileName}`;
  }

  private normalizeLocale(locale: string): string {
    return ["tr", "en"].includes(locale) ? locale : "tr";
  }

  private flattenPost(post: any, locale: string) {
    const t =
      post.translations?.find((t: any) => t.locale === locale) ??
      post.translations?.[0] ??
      {};
    return {
      id: post.id,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      date: post.date,
      coverImageUrl: post.coverImageUrl,
      title: t.title ?? "",
      excerpt: t.excerpt ?? "",
      content: t.content ?? "",
      category: t.category ?? "",
    };
  }

  // ---------------------------------------------------------------------------
  // Public endpoints
  // ---------------------------------------------------------------------------

  @SkipAuth()
  @Get()
  async list(@Query("locale") locale = "tr") {
    const posts = await this.prisma.blogPost.findMany({
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        date: true,
        coverImageUrl: true,
        translations: {
          select: { locale: true, title: true, excerpt: true, category: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    const validLocale = this.normalizeLocale(locale);
    const items = posts.map((p) => {
      const { content, ...rest } = this.flattenPost(p, validLocale);
      return rest;
    });
    return { ok: true, data: { items, total: items.length } };
  }

  @Roles("ADMIN", "PANELUSER")
  @Get(":id/full")
  async findOneFull(@Param("id") id: string) {
    const post = await this.prisma.blogPost.findUnique({
      where: { id },
      include: { translations: true },
    });
    if (!post) throw new NotFoundException("Blog post not found");
    const byLocale = Object.fromEntries(
      post.translations.map(({ locale, title, excerpt, content, category }) => [
        locale,
        { title, excerpt, content, category },
      ]),
    );
    return {
      ok: true,
      data: {
        id: post.id,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
        date: post.date,
        coverImageUrl: post.coverImageUrl,
        tr: byLocale["tr"] ?? null,
        en: byLocale["en"] ?? null,
      },
    };
  }

  @SkipAuth()
  @Get(":id")
  async findOne(@Param("id") id: string, @Query("locale") locale = "tr") {
    const post = await this.prisma.blogPost.findUnique({
      where: { id },
      include: { translations: true },
    });
    if (!post) throw new NotFoundException("Blog post not found");
    return { ok: true, data: this.flattenPost(post, this.normalizeLocale(locale)) };
  }

  // ---------------------------------------------------------------------------
  // Admin endpoints — CRUD
  // ---------------------------------------------------------------------------

  @Roles("ADMIN", "PANELUSER")
  @Post()
  async create(@Body() dto: CreateBlogPostDto) {
    const post = await this.prisma.blogPost.create({
      data: {
        date: dto.date,
        translations: {
          create: [
            { locale: "tr", ...dto.tr },
            { locale: "en", ...dto.en },
          ],
        },
      },
      include: { translations: true },
    });
    return { ok: true, data: post };
  }

  @Roles("ADMIN", "PANELUSER")
  @Patch(":id")
  async update(@Param("id") id: string, @Body() dto: UpdateBlogPostDto) {
    try {
      const post = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.blogPost.update({
          where: { id },
          data: { ...(dto.date !== undefined && { date: dto.date }) },
        });
        for (const loc of ["tr", "en"] as const) {
          if (dto[loc]) {
            await tx.blogPostTranslation.upsert({
              where: { postId_locale: { postId: id, locale: loc } },
              create: { postId: id, locale: loc, ...dto[loc] },
              update: { ...dto[loc] },
            });
          }
        }
        return updated;
      });
      return { ok: true, data: post };
    } catch (e: any) {
      if (e?.code === "P2025") throw new NotFoundException("Blog post not found");
      throw e;
    }
  }

  @Roles("ADMIN", "PANELUSER")
  @Delete(":id")
  async remove(@Param("id") id: string) {
    const existing = await this.prisma.blogPost.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Blog post not found");

    if (existing.coverImageUrl) {
      await this.supabase.storage
        .from("blog")
        .remove([this.storagePathFromUrl(existing.coverImageUrl)]);
    }

    await this.prisma.blogPost.delete({ where: { id } });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Admin endpoints — cover image
  // ---------------------------------------------------------------------------

  @Roles("ADMIN", "PANELUSER")
  @Post(":id/cover-image")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = ["image/png", "image/jpeg", "image/webp", "image/jpg"];
        if (allowed.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new BadRequestException("Only PNG, JPEG, WEBP images are allowed"), false);
        }
      },
    }),
  )
  async uploadCoverImage(@Param("id") id: string, @UploadedFile() file: any) {
    if (!file) throw new BadRequestException("No file provided");

    const existing = await this.prisma.blogPost.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Blog post not found");

    if (existing.coverImageUrl) {
      await this.supabase.storage
        .from("blog")
        .remove([this.storagePathFromUrl(existing.coverImageUrl)]);
    }

    const processed = await sharp(file.buffer)
      .resize(1600, 900, { fit: "cover", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    const fileName = `${id}/${crypto.randomUUID()}.webp`;
    const { error } = await this.supabase.storage
      .from("blog")
      .upload(fileName, processed, { contentType: "image/webp", upsert: false });

    if (error)
      throw new BadRequestException(`Storage upload failed: ${error.message}`);

    const post = await this.prisma.blogPost.update({
      where: { id },
      data: { coverImageUrl: this.publicUrl(fileName) },
    });
    return { ok: true, data: post };
  }

  @Roles("ADMIN", "PANELUSER")
  @Delete(":id/cover-image")
  async deleteCoverImage(@Param("id") id: string) {
    const existing = await this.prisma.blogPost.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Blog post not found");
    if (!existing.coverImageUrl) throw new BadRequestException("No cover image to delete");

    const { error } = await this.supabase.storage
      .from("blog")
      .remove([this.storagePathFromUrl(existing.coverImageUrl)]);
    if (error)
      throw new BadRequestException(`Storage delete failed: ${error.message}`);

    const post = await this.prisma.blogPost.update({
      where: { id },
      data: { coverImageUrl: null },
    });
    return { ok: true, data: post };
  }
}
