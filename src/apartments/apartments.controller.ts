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
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ConfigService } from "@nestjs/config";
import { memoryStorage } from "multer";
import { createClient } from "@supabase/supabase-js";
import { IsEnum, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { Transform, Type } from "class-transformer";
import { ApartmentStatus } from "@prisma/client";
import sharp from "sharp";
import { PrismaService } from "../prisma/prisma.service";
import { SkipAuth } from "../auth/skip-auth.decorator";
import { Roles } from "../auth/roles.decorator";

class CreateApartmentDto {
  @IsOptional()
  @IsEnum(ApartmentStatus)
  status?: ApartmentStatus;

  @IsString()
  address: string;

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

class DeleteImageDto {
  @IsString()
  url: string;
}

@Controller("apartments")
export class ApartmentsController {
  private supabase: ReturnType<typeof createClient>;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    this.supabase = createClient(
      this.config.get<string>("SUPABASE_URL") ?? "",
      this.config.get<string>("SUPABASE_SERVICE_KEY") ?? "",
    );
  }

  @SkipAuth()
  @Get()
  async list(@Query() query: ListApartmentsQuery) {
    const { status, limit = 20, offset = 0 } = query;

    const [items, total] = await Promise.all([
      this.prisma.apartment.findMany({
        where: status ? { status } : undefined,
        orderBy: { createdAt: "desc" },
        take: Number(limit),
        skip: Number(offset),
      }),
      this.prisma.apartment.count({
        where: status ? { status } : undefined,
      }),
    ]);

    return { ok: true, data: { items, total } };
  }

  @SkipAuth()
  @Get(":id")
  async findOne(@Param("id") id: string) {
    const apartment = await this.prisma.apartment.findUnique({ where: { id } });
    if (!apartment) throw new NotFoundException("Apartment not found");
    return { ok: true, data: apartment };
  }

  @Roles("ADMIN")
  @Post()
  async create(@Body() dto: CreateApartmentDto) {
    const apartment = await this.prisma.apartment.create({
      data: {
        status: dto.status ?? "AVAILABLE",
        address: dto.address,
        sqft: dto.sqft,
        priceUsd: dto.priceUsd,
        title: dto.title,
        description: dto.description,
        floor: dto.floor,
        roomCount: dto.roomCount,
        images: [],
      },
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
        ...(dto.sqft !== undefined && { sqft: dto.sqft }),
        ...(dto.priceUsd !== undefined && { priceUsd: dto.priceUsd }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.floor !== undefined && { floor: dto.floor }),
        ...(dto.roomCount !== undefined && { roomCount: dto.roomCount }),
      },
    });
    return { ok: true, data: apartment };
  }

  @Roles("ADMIN")
  @Delete(":id")
  async remove(@Param("id") id: string) {
    const existing = await this.prisma.apartment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Apartment not found");

    // Remove all images from Supabase storage
    if (existing.images.length > 0) {
      const paths = existing.images.map((url) => {
        const supabaseUrl = this.config.get<string>("SUPABASE_URL") ?? "";
        const prefix = `${supabaseUrl}/storage/v1/object/public/apartments/`;
        return url.startsWith(prefix) ? url.slice(prefix.length) : url;
      });
      await this.supabase.storage.from("apartments").remove(paths);
    }

    await this.prisma.apartment.delete({ where: { id } });
    return { ok: true };
  }

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
          cb(new BadRequestException("Only PNG, JPEG, WEBP images are allowed"), false);
        }
      },
    }),
  )
  async uploadImage(@Param("id") id: string, @UploadedFile() file: any) {
    if (!file) throw new BadRequestException("No file provided");

    const existing = await this.prisma.apartment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Apartment not found");

    const processed = await sharp(file.buffer)
      .resize(1400, 1400, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    const fileName = `${id}/${crypto.randomUUID()}.webp`;
    const { error } = await this.supabase.storage
      .from("apartments")
      .upload(fileName, processed, { contentType: "image/webp", upsert: false });

    if (error) throw new BadRequestException(`Storage upload failed: ${error.message}`);

    const supabaseUrl = this.config.get<string>("SUPABASE_URL") ?? "";
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/apartments/${fileName}`;

    const apartment = await this.prisma.apartment.update({
      where: { id },
      data: { images: { push: publicUrl } },
    });

    return { ok: true, data: apartment };
  }

  @Roles("ADMIN")
  @Delete(":id/images")
  async deleteImage(@Param("id") id: string, @Body() dto: DeleteImageDto) {
    const existing = await this.prisma.apartment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Apartment not found");

    if (!existing.images.includes(dto.url)) {
      throw new BadRequestException("Image URL not found on this apartment");
    }

    const supabaseUrl = this.config.get<string>("SUPABASE_URL") ?? "";
    const prefix = `${supabaseUrl}/storage/v1/object/public/apartments/`;
    const storagePath = dto.url.startsWith(prefix) ? dto.url.slice(prefix.length) : dto.url;

    const { error } = await this.supabase.storage.from("apartments").remove([storagePath]);
    if (error) throw new BadRequestException(`Storage delete failed: ${error.message}`);

    const apartment = await this.prisma.apartment.update({
      where: { id },
      data: { images: existing.images.filter((u) => u !== dto.url) },
    });

    return { ok: true, data: apartment };
  }
}
