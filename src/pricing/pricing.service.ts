import { Injectable } from "@nestjs/common";
import { PaymentPlan, PriceLevel, UnitType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

type PlanPriceRow = {
  cashCents: number;
  installment6Cents: number;
  installment12Cents: number;
};

export type ResolvedPrice = {
  basePriceCents: number;
  periodText: string;
  level: PriceLevel;
};

export type WeekUpdateItem = {
  weekOfYear: number;
  level?: PriceLevel;
  periodText?: string;
};

export type UnitPriceUpdateItem = {
  unitType: UnitType;
  level: PriceLevel;
  cashCents?: number;
  installment6Cents?: number;
  installment12Cents?: number;
};

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hafta -> seviye -> (unitType, seviye) satırı -> plan kolonu.
   * Satır eksikse null döner; çağıran taraf hata mesajını üretir.
   */
  async resolve(
    unitType: UnitType,
    weekOfYear: number,
    plan: PaymentPlan,
  ): Promise<ResolvedPrice | null> {
    const [week, priceRows] = await Promise.all([
      this.prisma.pricingWeek.findUnique({ where: { weekOfYear } }),
      this.prisma.unitTypePrice.findMany({ where: { unitType } }),
    ]);
    if (!week) return null;

    const row = priceRows.find((r) => r.level === week.level);
    if (!row) return null;

    return {
      basePriceCents: this.priceForPlan(row, plan),
      periodText: week.periodText,
      level: week.level,
    };
  }

  async getPeriodText(weekOfYear: number): Promise<string | null> {
    const week = await this.prisma.pricingWeek.findUnique({
      where: { weekOfYear },
      select: { periodText: true },
    });
    return week?.periodText ?? null;
  }

  async getConfig() {
    const [weeks, unitPrices] = await Promise.all([
      this.prisma.pricingWeek.findMany({
        orderBy: { weekOfYear: "asc" },
        select: { weekOfYear: true, level: true, periodText: true },
      }),
      this.prisma.unitTypePrice.findMany({
        orderBy: [{ unitType: "asc" }, { level: "asc" }],
        select: {
          unitType: true,
          level: true,
          cashCents: true,
          installment6Cents: true,
          installment12Cents: true,
        },
      }),
    ]);
    return { weeks, unitPrices };
  }

  async bulkUpdateWeeks(items: WeekUpdateItem[]) {
    // Olmayan hafta updateMany'de sessizce atlanır, tekil update'te P2025 fırlatırdı;
    // iki yolun da davranışı tutarlı olsun diye önce topluca varlık kontrolü yapılır.
    const requestedWeeks = [...new Set(items.map((i) => i.weekOfYear))];
    const existing = await this.prisma.pricingWeek.findMany({
      where: { weekOfYear: { in: requestedWeeks } },
      select: { weekOfYear: true },
    });
    const existingWeeks = new Set(existing.map((w) => w.weekOfYear));
    const missingWeeks = requestedWeeks.filter((w) => !existingWeeks.has(w));
    if (missingWeeks.length > 0) {
      return { updatedCount: 0, missingWeeks };
    }

    // Yalnızca seviye değişen haftalar seviyeye göre gruplanır (en fazla 3 updateMany);
    // periodText taşıyanlar tekil update olarak aynı transaction'a girer.
    const weeksByLevel = new Map<PriceLevel, number[]>();
    const singleUpdates: WeekUpdateItem[] = [];

    for (const item of items) {
      if (item.periodText !== undefined) {
        singleUpdates.push(item);
      } else if (item.level !== undefined) {
        const weeks = weeksByLevel.get(item.level) ?? [];
        weeks.push(item.weekOfYear);
        weeksByLevel.set(item.level, weeks);
      }
    }

    const results = await this.prisma.$transaction([
      ...[...weeksByLevel.entries()].map(([level, weeks]) =>
        this.prisma.pricingWeek.updateMany({
          where: { weekOfYear: { in: weeks } },
          data: { level },
        }),
      ),
      ...singleUpdates.map(({ weekOfYear, level, periodText }) =>
        this.prisma.pricingWeek.update({
          where: { weekOfYear },
          data: { ...(level !== undefined && { level }), periodText },
        }),
      ),
    ]);

    const updatedCount = results.reduce(
      (sum, r) => sum + ("count" in r ? r.count : 1),
      0,
    );
    return { updatedCount, missingWeeks: [] as number[] };
  }

  async bulkUpdateUnitPrices(items: UnitPriceUpdateItem[]) {
    const existing = await this.prisma.unitTypePrice.findMany({
      select: { unitType: true, level: true },
    });
    const existingKeys = new Set(existing.map((r) => `${r.unitType}:${r.level}`));
    const missingKeys = [
      ...new Set(items.map((i) => `${i.unitType}:${i.level}`)),
    ].filter((k) => !existingKeys.has(k));
    if (missingKeys.length > 0) {
      return { updatedCount: 0, missingKeys };
    }

    const updates = await this.prisma.$transaction(
      items.map(({ unitType, level, ...data }) =>
        this.prisma.unitTypePrice.update({
          where: { unitType_level: { unitType, level } },
          data,
        }),
      ),
    );
    return { updatedCount: updates.length, missingKeys: [] as string[] };
  }

  private priceForPlan(row: PlanPriceRow, plan: PaymentPlan): number {
    switch (plan) {
      case "PESIN":
        return row.cashCents;
      case "ALTIN":
        return row.installment6Cents; // UI: 6 Ay
      case "TAKSIT_12":
        return row.installment12Cents;
    }
  }
}
