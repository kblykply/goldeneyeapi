import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const MIGRATION_KEY = "eur-base-currency-v1";
const GBP_TO_EUR_RATE = Number(process.env.GBP_TO_EUR_RATE ?? "1.17");

async function ensureMarkerTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_data_migration_markers" (
      "key" TEXT PRIMARY KEY,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function hasRun() {
  const rows = await prisma.$queryRawUnsafe<Array<{ key: string }>>(
    `SELECT "key" FROM "_data_migration_markers" WHERE "key" = $1 LIMIT 1`,
    MIGRATION_KEY
  );
  return rows.length > 0;
}

async function markRun() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "_data_migration_markers" ("key") VALUES ($1) ON CONFLICT ("key") DO NOTHING`,
    MIGRATION_KEY
  );
}

async function convertAllMoneyColumns() {
  // Use a single explicit conversion rule across all canonical base-cents columns.
  await prisma.$executeRawUnsafe(
    `UPDATE "WeekPrice"
     SET "cashCents" = ROUND("cashCents" * $1)::INTEGER,
         "installment6Cents" = ROUND("installment6Cents" * $1)::INTEGER,
         "installment12Cents" = ROUND("installment12Cents" * $1)::INTEGER`,
    GBP_TO_EUR_RATE
  );

  await prisma.$executeRawUnsafe(
    `UPDATE "Presentation"
     SET "basePriceCents" = CASE
       WHEN "basePriceCents" IS NULL THEN NULL
       ELSE ROUND("basePriceCents" * $1)::INTEGER
     END`,
    GBP_TO_EUR_RATE
  );

  await prisma.$executeRawUnsafe(
    `UPDATE "Contract"
     SET "basePriceCents" = ROUND("basePriceCents" * $1)::INTEGER`,
    GBP_TO_EUR_RATE
  );

  await prisma.$executeRawUnsafe(
    `UPDATE "Commission"
     SET "baseAmountCents" = ROUND("baseAmountCents" * $1)::INTEGER`,
    GBP_TO_EUR_RATE
  );

  await prisma.$executeRawUnsafe(
    `UPDATE "custom_payment_plans"
     SET "baseTotalCents" = ROUND("baseTotalCents" * $1)::INTEGER`,
    GBP_TO_EUR_RATE
  );

  await prisma.$executeRawUnsafe(
    `UPDATE "custom_payment_installments"
     SET "baseAmountCents" = ROUND("baseAmountCents" * $1)::INTEGER`,
    GBP_TO_EUR_RATE
  );
}

async function main() {
  if (!Number.isFinite(GBP_TO_EUR_RATE) || GBP_TO_EUR_RATE <= 0) {
    throw new Error(`Invalid GBP_TO_EUR_RATE: ${GBP_TO_EUR_RATE}`);
  }

  await ensureMarkerTable();
  if (await hasRun()) {
    console.log(`Skipping: ${MIGRATION_KEY} already applied.`);
    return;
  }

  console.log(`Running ${MIGRATION_KEY} with GBP_TO_EUR_RATE=${GBP_TO_EUR_RATE}`);
  await convertAllMoneyColumns();
  await markRun();
  console.log("EUR base currency conversion completed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
