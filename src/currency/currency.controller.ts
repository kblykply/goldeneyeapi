import { Controller, Get, Post } from "@nestjs/common";
import { CurrencyService } from "./currency.service";
import { AuditService } from "../audit/audit.service";

@Controller("currency")
export class CurrencyController {
  constructor(
    private readonly currencyService: CurrencyService,
    private readonly audit: AuditService,
  ) {}

  @Get("rates")
  async getRates() {
    const rates = await this.currencyService.getRates();
    return { ok: true, base: "EUR", rates };
  }

  @Post("refresh")
  async refresh() {
    const result = await this.currencyService.refreshRates();

    await this.audit.log({
      action: 'EXCHANGE_RATES_REFRESHED',
      entityType: 'EXCHANGE_RATE',
      entityId: 'singleton',
      meta: result as Record<string, unknown>,
    });

    return { ok: true, ...result };
  }
}
