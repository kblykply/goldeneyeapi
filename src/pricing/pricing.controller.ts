import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { PriceLevel, UnitType } from "@prisma/client";
import { PricingService } from "./pricing.service";
import { RolesGuard } from "../auth/roles.guard";
import { Roles } from "../auth/roles.decorator";
import { AuditService } from "../audit/audit.service";

class WeekUpdateItemDto {
  @IsInt()
  @Min(1)
  @Max(52)
  weekOfYear!: number;

  @IsOptional()
  @IsEnum(PriceLevel)
  level?: PriceLevel;

  @IsOptional()
  @IsString()
  periodText?: string;
}

class WeeksBulkUpdateDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeekUpdateItemDto)
  items!: WeekUpdateItemDto[];
}

class UnitPriceUpdateItemDto {
  @IsEnum(UnitType)
  unitType!: UnitType;

  @IsEnum(PriceLevel)
  level!: PriceLevel;

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

class UnitPricesBulkUpdateDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UnitPriceUpdateItemDto)
  items!: UnitPriceUpdateItemDto[];
}

@Controller("pricing")
@UseGuards(RolesGuard)
export class PricingController {
  constructor(
    private readonly pricingService: PricingService,
    private readonly audit: AuditService,
  ) {}

  @Get("config")
  async getConfig() {
    const config = await this.pricingService.getConfig();
    return { ok: true, ...config };
  }

  @Patch("weeks/bulk")
  @Roles("ADMIN", "AUTHORITY")
  async bulkUpdateWeeks(@Body() body: WeeksBulkUpdateDto) {
    const result = await this.pricingService.bulkUpdateWeeks(body.items);

    if (result.missingWeeks.length > 0) {
      return {
        ok: false,
        message: `Takvimde bulunmayan haftalar: ${result.missingWeeks.join(", ")}`,
      };
    }

    await this.audit.log({
      action: "PRICING_WEEKS_BULK_UPDATED",
      entityType: "PRICING",
      entityId: "weeks",
      meta: {
        updatedCount: result.updatedCount,
        weeks: body.items.map((i) => i.weekOfYear),
      },
    });

    return { ok: true, updatedCount: result.updatedCount };
  }

  @Patch("unit-prices/bulk")
  @Roles("ADMIN", "AUTHORITY")
  async bulkUpdateUnitPrices(@Body() body: UnitPricesBulkUpdateDto) {
    const result = await this.pricingService.bulkUpdateUnitPrices(body.items);

    if (result.missingKeys.length > 0) {
      return {
        ok: false,
        message: `Fiyat matrisinde bulunmayan kayıtlar: ${result.missingKeys.join(", ")}`,
      };
    }

    await this.audit.log({
      action: "UNIT_TYPE_PRICES_BULK_UPDATED",
      entityType: "PRICING",
      entityId: "unit-prices",
      meta: {
        updatedCount: result.updatedCount,
        keys: body.items.map((i) => `${i.unitType}:${i.level}`),
      },
    });

    return { ok: true, updatedCount: result.updatedCount };
  }
}
