import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../cache/cache.service";

const SUPPORTED: string[] = ["GBP", "EUR", "USD", "TRY"];
const BASE = "EUR";
const API_URL = `https://open.er-api.com/v6/latest/${BASE}`;

const FX_CACHE_KEY = "fx:rates";
// Kurlar günde bir kez cron ile yenilenir; cron sonunda cache düşürülür
const FX_CACHE_TTL_MS = 24 * 3600_000;

type RateRow = { fromCurrency: string; toCurrency: string; rate: number; updatedAt: Date };

@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

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
    this.cache.del(FX_CACHE_KEY);
    return { updated, rates: snapshot };
  }

  async getRates(): Promise<RateRow[]> {
    return this.cache.getOrSet(FX_CACHE_KEY, FX_CACHE_TTL_MS, async () => {
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
    });
  }

  /** Convert base-currency cents -> target currency amount (2 decimal places) */
  async convertFromBaseCents(baseCents: number, toCurrency: string): Promise<number> {
    if (toCurrency === BASE) return Math.round(baseCents) / 100;

    const rates = await this.getRates();
    const row = rates.find((r) => r.toCurrency === toCurrency);

    if (!row) throw new Error(`No exchange rate found for ${BASE} → ${toCurrency}`);

    const baseAmount = baseCents / 100;
    return Math.round(baseAmount * row.rate * 100) / 100;
  }
}
