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
import { IsEnum, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { Type } from "class-transformer";
import { ApartmentStatus } from "@prisma/client";
import sharp from "sharp";
import { PrismaService } from "../prisma/prisma.service";
import { SkipAuth } from "../auth/skip-auth.decorator";
import { Roles } from "../auth/roles.decorator";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

class CreateApartmentDto {
  @IsOptional()
  @IsEnum(ApartmentStatus)
  status?: ApartmentStatus;

  @IsString()
  address: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  longitude?: number;

  @IsNumber()
  @Type(() => Number)
  sqft: number;

  @IsNumber()
  @Type(() => Number)
  priceUsd: number;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  floor?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  roomCount?: number;
}

class UpdateApartmentDto {
  @IsOptional()
  @IsEnum(ApartmentStatus)
  status?: ApartmentStatus;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  longitude?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  sqft?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  priceUsd?: number;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  floor?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  roomCount?: number;
}

class ListApartmentsQuery {
  @IsOptional()
  @IsEnum(ApartmentStatus)
  status?: ApartmentStatus;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  offset?: number = 0;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@Controller("apartments")
export class ApartmentsController {
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
    const prefix = `${this._supabaseUrl}/storage/v1/object/public/apartments/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : url;
  }

  private publicUrl(fileName: string): string {
    return `${this._supabaseUrl}/storage/v1/object/public/apartments/${fileName}`;
  }

  private async findWithImages(id: string) {
    return this.prisma.apartment.findUnique({
      where: { id },
      include: { images: { orderBy: { order: "asc" } } },
    });
  }

  // ---------------------------------------------------------------------------
  // Public endpoints
  // ---------------------------------------------------------------------------

  /** List apartments — returns cover image only per apartment */
  @SkipAuth()
  @Get()
  async list(@Query() query: ListApartmentsQuery) {
    const { status, limit = 20, offset = 0 } = query;
    const where = status ? { status } : undefined;

    const [raw, total] = await Promise.all([
      this.prisma.apartment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Number(limit),
        skip: Number(offset),
        include: {
          images: { where: { isCover: true }, take: 1 },
        },
      }),
      this.prisma.apartment.count({ where }),
    ]);

    const items = raw.map(({ images, ...apt }) => ({
      ...apt,
      coverImage: images[0] ?? null,
    }));

    return { ok: true, data: { items, total } };
  }

  /** Get single apartment — returns all images */
  @SkipAuth()
  @Get(":id")
  async findOne(@Param("id") id: string) {
    const apartment = await this.findWithImages(id);
    if (!apartment) throw new NotFoundException("Apartment not found");
    return { ok: true, data: apartment };
  }

  // ---------------------------------------------------------------------------
  // Admin endpoints — CRUD
  // ---------------------------------------------------------------------------

  @Roles("ADMIN")
  @Post()
  async create(@Body() dto: CreateApartmentDto) {
    const apartment = await this.prisma.apartment.create({
      data: {
        status: dto.status ?? "AVAILABLE",
        address: dto.address,
        latitude: dto.latitude,
        longitude: dto.longitude,
        sqft: dto.sqft,
        priceUsd: dto.priceUsd,
        title: dto.title,
        description: dto.description,
        floor: dto.floor,
        roomCount: dto.roomCount,
      },
      include: { images: { orderBy: { order: "asc" } } },
    });
    return { ok: true, data: apartment };
  }

  @Roles("ADMIN")
  @Patch(":id")
  async update(@Param("id") id: string, @Body() dto: UpdateApartmentDto) {
    const existing = await this.prisma.apartment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Apartment not found");

    const apartment = await this.prisma.apartment.update({
      where: { id },
      data: {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.latitude !== undefined && { latitude: dto.latitude }),
        ...(dto.longitude !== undefined && { longitude: dto.longitude }),
        ...(dto.sqft !== undefined && { sqft: dto.sqft }),
        ...(dto.priceUsd !== undefined && { priceUsd: dto.priceUsd }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.floor !== undefined && { floor: dto.floor }),
        ...(dto.roomCount !== undefined && { roomCount: dto.roomCount }),
      },
      include: { images: { orderBy: { order: "asc" } } },
    });
    return { ok: true, data: apartment };
  }

  @Roles("ADMIN")
  @Delete(":id")
  async remove(@Param("id") id: string) {
    const existing = await this.findWithImages(id);
    if (!existing) throw new NotFoundException("Apartment not found");

    if (existing.images.length > 0) {
      const paths = existing.images.map((img) =>
        this.storagePathFromUrl(img.url),
      );
      await this.supabase.storage.from("apartments").remove(paths);
    }

    await this.prisma.apartment.delete({ where: { id } });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Admin endpoints — image management
  // ---------------------------------------------------------------------------

  /** Upload a new image. Auto-sets as cover if it's the first one. */
  @Roles("ADMIN")
  @Post(":id/images")
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

    const existing = await this.findWithImages(id);
    if (!existing) throw new NotFoundException("Apartment not found");

    const processed = await sharp(file.buffer)
      .resize(1400, 1400, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    const fileName = `${id}/${crypto.randomUUID()}.webp`;
    const { error } = await this.supabase.storage
      .from("apartments")
      .upload(fileName, processed, { contentType: "image/webp", upsert: false });

    if (error)
      throw new BadRequestException(`Storage upload failed: ${error.message}`);

    const isFirstImage = existing.images.length === 0;
    const nextOrder = isFirstImage
      ? 0
      : Math.max(...existing.images.map((i) => i.order)) + 1;

    await this.prisma.apartmentImage.create({
      data: {
        apartmentId: id,
        url: this.publicUrl(fileName),
        isCover: isFirstImage,
        order: nextOrder,
      },
    });

    const apartment = await this.findWithImages(id);
    return { ok: true, data: apartment };
  }

  /** Delete a specific image by its ID */
  @Roles("ADMIN")
  @Delete(":id/images/:imageId")
  async deleteImage(
    @Param("id") id: string,
    @Param("imageId") imageId: string,
  ) {
    const image = await this.prisma.apartmentImage.findUnique({
      where: { id: imageId },
    });
    if (!image || image.apartmentId !== id)
      throw new NotFoundException("Image not found");

    const { error } = await this.supabase.storage
      .from("apartments")
      .remove([this.storagePathFromUrl(image.url)]);
    if (error)
      throw new BadRequestException(`Storage delete failed: ${error.message}`);

    await this.prisma.apartmentImage.delete({ where: { id: imageId } });

    if (image.isCover) {
      const next = await this.prisma.apartmentImage.findFirst({
        where: { apartmentId: id },
        orderBy: { order: "asc" },
      });
      if (next) {
        await this.prisma.apartmentImage.update({
          where: { id: next.id },
          data: { isCover: true },
        });
      }
    }

    const apartment = await this.findWithImages(id);
    return { ok: true, data: apartment };
  }

  /** Set a specific image as the cover */
  @Roles("ADMIN")
  @Patch(":id/images/:imageId/cover")
  async setCover(
    @Param("id") id: string,
    @Param("imageId") imageId: string,
  ) {
    const image = await this.prisma.apartmentImage.findUnique({
      where: { id: imageId },
    });
    if (!image || image.apartmentId !== id)
      throw new NotFoundException("Image not found");

    await this.prisma.$transaction([
      this.prisma.apartmentImage.updateMany({
        where: { apartmentId: id },
        data: { isCover: false },
      }),
      this.prisma.apartmentImage.update({
        where: { id: imageId },
        data: { isCover: true },
      }),
    ]);

    const apartment = await this.findWithImages(id);
    return { ok: true, data: apartment };
  }
}
