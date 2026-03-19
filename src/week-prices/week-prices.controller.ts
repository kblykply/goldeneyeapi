import { Body, Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { IsArray, IsInt, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { WeekPricesService } from "./week-prices.service";
import { RolesGuard } from "../auth/roles.guard";
import { Roles } from "../auth/roles.decorator";

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
  constructor(private readonly weekPricesService: WeekPricesService) {}

  @Get()
  async list() {
    const prices = await this.weekPricesService.list();
    return { ok: true, prices };
  }

  @Patch("bulk")
  @Roles("ADMIN")
  async bulkUpdate(@Body() body: BulkUpdateDto) {
    const result = await this.weekPricesService.bulkUpdate(body.items);
    return { ok: true, ...result };
  }

  @Patch(":id")
  @Roles("ADMIN")
  async updateOne(@Param("id") id: string, @Body() body: UpdateWeekPriceDto) {
    const updated = await this.weekPricesService.updateOne(id, body);
    if (!updated) return { ok: false, message: "Fiyat kaydı bulunamadı" };
    return { ok: true, price: updated };
  }
}
