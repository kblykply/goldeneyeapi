import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BASE = "EUR";
const CURRENCIES = ["EUR", "GBP", "USD", "TRY"];
const API_URL = `https://open.er-api.com/v6/latest/${BASE}`;

async function main() {
  console.log(`Fetching rates from ${API_URL}...`);
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  const data = (await res.json()) as { rates: Record<string, number> };

  for (const currency of CURRENCIES) {
    const rate = data.rates[currency];
    if (rate == null) {
      console.warn(`⚠️  No rate for ${currency}`);
      continue;
    }

    await prisma.exchangeRate.upsert({
      where: { fromCurrency_toCurrency: { fromCurrency: BASE, toCurrency: currency } },
      update: { rate },
      create: { fromCurrency: BASE, toCurrency: currency, rate },
    });

    console.log(`✅ EUR → ${currency}: ${rate}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
