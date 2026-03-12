import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";

const SUPPORTED: string[] = ["GBP", "EUR", "USD", "TRY"];
const BASE = "EUR";
const API_URL = `https://open.er-api.com/v6/latest/${BASE}`;

@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async refreshRatesScheduled() {
    this.logger.log("⏰ Daily exchange rate refresh triggered");
    await this.refreshRates();
  }

  async refreshRates(): Promise<{ updated: string[]; rates: Record<string, number> }> {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error(`Exchange rate API error: ${res.status}`);

    const data = (await res.json()) as { rates: Record<string, number> };

    const updated: string[] = [];
    const snapshot: Record<string, number> = {};

    for (const currency of SUPPORTED) {
      const rate = data.rates[currency];
      if (rate == null) continue;

      await this.prisma.exchangeRate.upsert({
        where: { fromCurrency_toCurrency: { fromCurrency: BASE, toCurrency: currency } },
        update: { rate },
        create: { fromCurrency: BASE, toCurrency: currency, rate },
      });

      updated.push(currency);
      snapshot[currency] = rate;
    }

    this.logger.log(`✅ Exchange rates updated: ${updated.join(", ")}`);
    return { updated, rates: snapshot };
  }

  async getRates(): Promise<{ fromCurrency: string; toCurrency: string; rate: number; updatedAt: Date }[]> {
    const rows = await this.prisma.exchangeRate.findMany({
      where: { fromCurrency: BASE },
      orderBy: { toCurrency: "asc" },
    });

    return rows.map((r) => ({
      fromCurrency: r.fromCurrency,
      toCurrency: r.toCurrency,
      rate: Number(r.rate),
      updatedAt: r.updatedAt,
    }));
  }

  /** Convert base-currency cents -> target currency amount (2 decimal places) */
  async convertFromBaseCents(baseCents: number, toCurrency: string): Promise<number> {
    if (toCurrency === BASE) return Math.round(baseCents) / 100;

    const row = await this.prisma.exchangeRate.findUnique({
      where: { fromCurrency_toCurrency: { fromCurrency: BASE, toCurrency } },
    });

    if (!row) throw new Error(`No exchange rate found for ${BASE} → ${toCurrency}`);

    const baseAmount = baseCents / 100;
    return Math.round(baseAmount * Number(row.rate) * 100) / 100;
  }
}
