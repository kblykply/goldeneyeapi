import { PrismaClient, UnitType } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

function formatRows(rows: { weekOfYear: number; periodText: string; taksit12Cents: number; taksit6Cents: number; pesinCents: number }[]) {
  return rows
    .sort((a, b) => a.weekOfYear - b.weekOfYear)
    .map((r) => {
      const pad = (n: number) => String(n).padStart(7, " ");
      return `    { weekOfYear: ${String(r.weekOfYear).padEnd(2, " ")}, periodText: "${r.periodText}", taksit12Cents: ${pad(r.taksit12Cents)}, taksit6Cents: ${pad(r.taksit6Cents)}, pesinCents: ${pad(r.pesinCents)} },`;
    })
    .join("\n");
}

async function main() {
  const all = await prisma.weekPrice.findMany({
    orderBy: [{ unitType: "asc" }, { weekOfYear: "asc" }],
  });

  const byType = (type: UnitType) => all.filter((r) => r.unitType === type);

  const studio = byType("STUDIO");
  const onePlusOne = byType("ONE_PLUS_ONE");
  const twoPlusOne = byType("TWO_PLUS_ONE");

  console.log(`Fetched: STUDIO=${studio.length}, ONE_PLUS_ONE=${onePlusOne.length}, TWO_PLUS_ONE=${twoPlusOne.length}`);

  const content = `import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const studio = [
${formatRows(studio)}
  ];

    // ONE_PLUS_ONE prices (GBP pence) + periodText
  const onePlusOne = [
${formatRows(onePlusOne)}
  ];


    // TWO_PLUS_ONE prices (GBP pence) + periodText
  const twoPlusOne = [
${formatRows(twoPlusOne)}
  ];

  for (const r of twoPlusOne) {
    await prisma.weekPrice.upsert({
      where: { unitType_weekOfYear: { unitType: "TWO_PLUS_ONE", weekOfYear: r.weekOfYear } },
      update: {
        periodText: r.periodText,
        pesinCents: r.pesinCents,
        taksit6Cents: r.taksit6Cents,
        taksit12Cents: r.taksit12Cents,
      },
      create: {
        unitType: "TWO_PLUS_ONE",
        weekOfYear: r.weekOfYear,
        periodText: r.periodText,
        pesinCents: r.pesinCents,
        taksit6Cents: r.taksit6Cents,
        taksit12Cents: r.taksit12Cents,
      },
    });
  }

  console.log("✅ TWO_PLUS_ONE week prices upserted:", twoPlusOne.length);

  for (const r of onePlusOne) {
    await prisma.weekPrice.upsert({
      where: { unitType_weekOfYear: { unitType: "ONE_PLUS_ONE", weekOfYear: r.weekOfYear } },
      update: {
        periodText: r.periodText,
        pesinCents: r.pesinCents,
        taksit6Cents: r.taksit6Cents,
        taksit12Cents: r.taksit12Cents,
      },
      create: {
        unitType: "ONE_PLUS_ONE",
        weekOfYear: r.weekOfYear,
        periodText: r.periodText,
        pesinCents: r.pesinCents,
        taksit6Cents: r.taksit6Cents,
        taksit12Cents: r.taksit12Cents,
      },
    });
  }

  console.log("✅ ONE_PLUS_ONE week prices upserted:", onePlusOne.length);

  for (const r of studio) {
    await prisma.weekPrice.upsert({
      where: { unitType_weekOfYear: { unitType: "STUDIO", weekOfYear: r.weekOfYear } },
      update: {
        periodText: r.periodText,
        pesinCents: r.pesinCents,
        taksit6Cents: r.taksit6Cents,
        taksit12Cents: r.taksit12Cents,
      },
      create: {
        unitType: "STUDIO",
        weekOfYear: r.weekOfYear,
        periodText: r.periodText,
        pesinCents: r.pesinCents,
        taksit6Cents: r.taksit6Cents,
        taksit12Cents: r.taksit12Cents,
      },
    });
  }

  console.log("✅ STUDIO week prices upserted:", studio.length);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
`;

  const outPath = path.join(__dirname, "seed-week-prices.ts");
  fs.writeFileSync(outPath, content, "utf-8");
  console.log(`✅ seed-week-prices.ts updated at: ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
