import { Body, Controller, Get, Param, Patch, Req, UseGuards } from "@nestjs/common";
import { IsArray, IsInt, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { WeekPricesService } from "./week-prices.service";
import { RolesGuard } from "../auth/roles.guard";
import { Roles } from "../auth/roles.decorator";
import { AuditService } from "../audit/audit.service";
import { Request } from "express";
import { AuthedUser } from "../auth/auth.types";

class UpdateWeekPriceDto {
  @IsOptional()
  @IsString()
  periodText?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  cashCents?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  installment6Cents?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  installment12Cents?: number;
}

class BulkUpdateItemDto {
  @IsString()
  id!: string;

  @ValidateNested()
  @Type(() => UpdateWeekPriceDto)
  data!: UpdateWeekPriceDto;
}

class BulkUpdateDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkUpdateItemDto)
  items!: BulkUpdateItemDto[];
}

@Controller("week-prices")
@UseGuards(RolesGuard)
export class WeekPricesController {
  constructor(
    private readonly weekPricesService: WeekPricesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    const prices = await this.weekPricesService.list();
    return { ok: true, prices };
  }

  @Patch("bulk")
  @Roles("ADMIN")
  async bulkUpdate(
    @Body() body: BulkUpdateDto,
    @Req() _req: Request & { user: AuthedUser },
  ) {
    const result = await this.weekPricesService.bulkUpdate(body.items);

    await this.audit.log({
      action: 'WEEK_PRICES_BULK_UPDATED',
      entityType: 'WEEK_PRICE',
      entityId: 'bulk',
      meta: { updatedCount: result.updatedCount, ids: body.items.map((i) => i.id) },
    });

    return { ok: true, ...result };
  }

  @Patch(":id")
  @Roles("ADMIN")
  async updateOne(
    @Param("id") id: string,
    @Body() body: UpdateWeekPriceDto,
    @Req() _req: Request & { user: AuthedUser },
  ) {
    const updated = await this.weekPricesService.updateOne(id, body);
    if (!updated) return { ok: false, message: "Fiyat kaydı bulunamadı" };

    await this.audit.log({
      action: 'WEEK_PRICE_UPDATED',
      entityType: 'WEEK_PRICE',
      entityId: id,
      meta: { fields: Object.keys(body).filter((k) => (body as any)[k] !== undefined) },
    });

    return { ok: true, price: updated };
  }
}
