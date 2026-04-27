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

class CreateBlogPostDto {
  @IsString() title: string;
  @IsString() excerpt: string;
  @IsString() content: string;
  @IsString() date: string;
  @IsString() category: string;
}

class UpdateBlogPostDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() excerpt?: string;
  @IsOptional() @IsString() content?: string;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() category?: string;
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

  // ---------------------------------------------------------------------------
  // Public endpoints
  // ---------------------------------------------------------------------------

  @SkipAuth()
  @Get()
  async list() {
    const items = await this.prisma.blogPost.findMany({
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        title: true,
        excerpt: true,
        date: true,
        category: true,
        coverImageUrl: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return { ok: true, data: { items, total: items.length } };
  }

  @SkipAuth()
  @Get(":id")
  async findOne(@Param("id") id: string) {
    const post = await this.prisma.blogPost.findUnique({ where: { id } });
    if (!post) throw new NotFoundException("Blog post not found");
    return { ok: true, data: post };
  }

  // ---------------------------------------------------------------------------
  // Admin endpoints — CRUD
  // ---------------------------------------------------------------------------

  @Roles("ADMIN")
  @Post()
  async create(@Body() dto: CreateBlogPostDto) {
    const post = await this.prisma.blogPost.create({ data: dto });
    return { ok: true, data: post };
  }

  @Roles("ADMIN")
  @Patch(":id")
  async update(@Param("id") id: string, @Body() dto: UpdateBlogPostDto) {
    try {
      const post = await this.prisma.blogPost.update({
        where: { id },
        data: {
          ...(dto.title !== undefined && { title: dto.title }),
          ...(dto.excerpt !== undefined && { excerpt: dto.excerpt }),
          ...(dto.content !== undefined && { content: dto.content }),
          ...(dto.date !== undefined && { date: dto.date }),
          ...(dto.category !== undefined && { category: dto.category }),
        },
      });
      return { ok: true, data: post };
    } catch (e: any) {
      if (e?.code === "P2025") throw new NotFoundException("Blog post not found");
      throw e;
    }
  }

  @Roles("ADMIN")
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

  @Roles("ADMIN")
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

  @Roles("ADMIN")
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
