import { PriceLevel, PrismaClient, UnitType, WeekPrice } from "@prisma/client";

/**
 * UnitTypePrice + PricingWeek tablolarını mevcut WeekPrice verisinden türetir.
 *
 * - UnitType başına en sık görülen 3 cashCents kademesi küçükten büyüğe
 *   LOW / MEDIUM / HIGH olarak eşlenir (9 UnitTypePrice satırı).
 * - Her haftanın seviyesi STUDIO satırının cashCents'ine en yakın kademeden
 *   atanır, periodText kopyalanır (52 PricingWeek satırı).
 * - WeekPrice boşsa: tüm haftalar MEDIUM + "{w}. Hafta", fiyat matrisi 0.
 *
 * Idempotent: upsert ile çalışır, tekrar koşulabilir.
 * Sonda eski (WeekPrice) ve yeni (seviye bazlı) fiyatların diff raporunu basar.
 */

const prisma = new PrismaClient();

const UNIT_TYPES = Object.values(UnitType);
const LEVELS: PriceLevel[] = [PriceLevel.LOW, PriceLevel.MEDIUM, PriceLevel.HIGH];
const WEEK_COUNT = 52;

type TierRow = Pick<WeekPrice, "cashCents" | "installment6Cents" | "installment12Cents">;

function dominantTiers(rows: WeekPrice[]): Map<PriceLevel, TierRow> {
  const byCash = new Map<number, { count: number; row: TierRow }>();
  for (const row of rows) {
    const entry = byCash.get(row.cashCents) ?? {
      count: 0,
      row: {
        cashCents: row.cashCents,
        installment6Cents: row.installment6Cents,
        installment12Cents: row.installment12Cents,
      },
    };
    entry.count += 1;
    byCash.set(row.cashCents, entry);
  }

  const top3 = [...byCash.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .sort((a, b) => a.row.cashCents - b.row.cashCents);

  const tiers = new Map<PriceLevel, TierRow>();
  top3.forEach((entry, i) => tiers.set(LEVELS[i], entry.row));
  return tiers;
}

function nearestLevel(cashCents: number, tiers: Map<PriceLevel, TierRow>): PriceLevel {
  // Eşit uzaklıkta yüksek kademe kazanır (<= ve LOW→HIGH ekleme sırası):
  // geçişte hiçbir haftanın fiyatı düşmesin.
  let best: PriceLevel = PriceLevel.MEDIUM;
  let bestDistance = Infinity;
  for (const [level, row] of tiers) {
    const distance = Math.abs(row.cashCents - cashCents);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = level;
    }
  }
  return best;
}

function planPrice(row: TierRow, plan: "PESIN" | "ALTIN" | "TAKSIT_12"): number {
  if (plan === "PESIN") return row.cashCents;
  if (plan === "ALTIN") return row.installment6Cents;
  return row.installment12Cents;
}

async function seedFallback() {
  console.warn("⚠️  WeekPrice boş — tüm haftalar MEDIUM, fiyat matrisi 0 olarak kuruluyor.");

  await prisma.$transaction([
    ...UNIT_TYPES.flatMap((unitType) =>
      LEVELS.map((level) =>
        prisma.unitTypePrice.upsert({
          where: { unitType_level: { unitType, level } },
          update: {},
          create: { unitType, level, cashCents: 0, installment6Cents: 0, installment12Cents: 0 },
        }),
      ),
    ),
    ...Array.from({ length: WEEK_COUNT }, (_, i) => i + 1).map((weekOfYear) =>
      prisma.pricingWeek.upsert({
        where: { weekOfYear },
        update: {},
        create: { weekOfYear, level: PriceLevel.MEDIUM, periodText: `${weekOfYear}. Hafta` },
      }),
    ),
  ]);
}

async function main() {
  const weekPrices = await prisma.weekPrice.findMany({
    orderBy: [{ unitType: "asc" }, { weekOfYear: "asc" }],
  });

  if (weekPrices.length === 0) {
    await seedFallback();
    return;
  }

  const rowsByUnit = new Map<UnitType, WeekPrice[]>(
    UNIT_TYPES.map((u) => [u, weekPrices.filter((r) => r.unitType === u)]),
  );

  // 9 UnitTypePrice satırı
  const tiersByUnit = new Map<UnitType, Map<PriceLevel, TierRow>>();
  for (const unitType of UNIT_TYPES) {
    const tiers = dominantTiers(rowsByUnit.get(unitType)!);
    if (tiers.size < 3) {
      throw new Error(`${unitType} için 3 fiyat kademesi türetilemedi (bulunan: ${tiers.size})`);
    }
    tiersByUnit.set(unitType, tiers);
  }

  // 52 PricingWeek satırı — seviye STUDIO kademelerine göre
  const studioTiers = tiersByUnit.get(UnitType.STUDIO)!;
  const studioRows = rowsByUnit.get(UnitType.STUDIO)!;
  const weekRows = studioRows.map((row) => ({
    weekOfYear: row.weekOfYear,
    level: nearestLevel(row.cashCents, studioTiers),
    periodText: row.periodText,
  }));

  await prisma.$transaction([
    ...[...tiersByUnit.entries()].flatMap(([unitType, tiers]) =>
      [...tiers.entries()].map(([level, row]) =>
        prisma.unitTypePrice.upsert({
          where: { unitType_level: { unitType, level } },
          update: { ...row },
          create: { unitType, level, ...row },
        }),
      ),
    ),
    ...weekRows.map(({ weekOfYear, level, periodText }) =>
      prisma.pricingWeek.upsert({
        where: { weekOfYear },
        update: { level, periodText },
        create: { weekOfYear, level, periodText },
      }),
    ),
  ]);

  console.log(`✅ ${tiersByUnit.size * 3} UnitTypePrice + ${weekRows.length} PricingWeek satırı yazıldı.\n`);

  // Diff raporu: eski WeekPrice fiyatı vs yeni seviye bazlı fiyat
  const levelByWeek = new Map(weekRows.map((w) => [w.weekOfYear, w.level]));
  let mismatches = 0;

  for (const unitType of UNIT_TYPES) {
    const tiers = tiersByUnit.get(unitType)!;
    for (const row of rowsByUnit.get(unitType)!) {
      const level = levelByWeek.get(row.weekOfYear)!;
      const tier = tiers.get(level)!;
      for (const plan of ["PESIN", "ALTIN", "TAKSIT_12"] as const) {
        const oldPrice = planPrice(row, plan);
        const newPrice = planPrice(tier, plan);
        if (oldPrice !== newPrice) {
          mismatches += 1;
          console.warn(
            `  Δ ${unitType} hafta ${row.weekOfYear} ${plan}: eski ${oldPrice} → yeni ${newPrice} (${level})`,
          );
        }
      }
    }
  }

  if (mismatches === 0) {
    console.log("✅ Diff raporu: tüm fiyatlar eski sistemle birebir aynı.");
  } else {
    console.warn(`⚠️  Diff raporu: ${mismatches} fiyat farklı (aykırı haftalar en yakın kademeye eşlendi).`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
