import { PrismaClient, UnitType } from "@prisma/client";

const prisma = new PrismaClient();

const UNIT_TYPES: UnitType[] = ["STUDIO", "ONE_PLUS_ONE", "TWO_PLUS_ONE"];
const EXPECTED_WEEKS = 52;

function missingWeeks(rows: Array<{ weekOfYear: number }>) {
  const set = new Set(rows.map((r) => r.weekOfYear));
  const missing: number[] = [];
  for (let w = 1; w <= EXPECTED_WEEKS; w += 1) {
    if (!set.has(w)) missing.push(w);
  }
  return missing;
}

async function main() {
  const weekPriceHasNewColumns = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'WeekPrice' AND column_name = 'cashCents'
    )`
  );
  const migratedSchema = weekPriceHasNewColumns[0]?.exists === true;

  const weekPrices = await prisma.$queryRawUnsafe<
    Array<{ unitType: UnitType; weekOfYear: number; cashCents: number; installment6Cents: number; installment12Cents: number }>
  >(
    migratedSchema
      ? `SELECT "unitType", "weekOfYear", "cashCents", "installment6Cents", "installment12Cents"
         FROM "WeekPrice"
         ORDER BY "unitType" ASC, "weekOfYear" ASC`
      : `SELECT "unitType", "weekOfYear",
                "pesinCents" AS "cashCents",
                "taksit6Cents" AS "installment6Cents",
                "taksit12Cents" AS "installment12Cents"
         FROM "WeekPrice"
         ORDER BY "unitType" ASC, "weekOfYear" ASC`
  );

  const presentationNullPriceRows = await prisma.$queryRawUnsafe<Array<{ count: string }>>(
    migratedSchema
      ? `SELECT COUNT(*)::text AS count
         FROM "Presentation"
         WHERE "unitType" IS NOT NULL AND "weekOfYear" IS NOT NULL AND "paymentPlan" IS NOT NULL AND "basePriceCents" IS NULL`
      : `SELECT COUNT(*)::text AS count
         FROM "Presentation"
         WHERE "unitType" IS NOT NULL AND "weekOfYear" IS NOT NULL AND "paymentPlan" IS NOT NULL AND "priceCents" IS NULL`
  );
  const presentationNullPriceCount = Number(presentationNullPriceRows[0]?.count ?? "0");

  const markerTableRows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT to_regclass('"_data_migration_markers"') IS NOT NULL AS exists`
  );
  const markerTableExists = markerTableRows[0]?.exists === true;

  const markerRows = markerTableExists
    ? await prisma.$queryRawUnsafe<Array<{ key: string }>>(
        `SELECT "key" FROM "_data_migration_markers" WHERE "key" = 'eur-base-currency-v1' LIMIT 1`
      )
    : [];

  const byType = Object.fromEntries(
    UNIT_TYPES.map((unitType) => [unitType, weekPrices.filter((r) => r.unitType === unitType)])
  ) as Record<UnitType, typeof weekPrices>;

  const negatives = weekPrices.filter(
    (r) => r.cashCents < 0 || r.installment6Cents < 0 || r.installment12Cents < 0
  );

  const report = {
    migratedSchema,
    markerTableExists,
    markerApplied: markerRows.length > 0,
    weekPriceRowCount: weekPrices.length,
    expectedWeekPriceRowCount: UNIT_TYPES.length * EXPECTED_WEEKS,
    missingWeeksByUnit: Object.fromEntries(
      UNIT_TYPES.map((unitType) => [unitType, missingWeeks(byType[unitType])])
    ),
    negativeWeekPriceRows: negatives.length,
    presentationRowsMissingBasePrice: presentationNullPriceCount,
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
