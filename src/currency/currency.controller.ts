import { Controller, Get, Post } from "@nestjs/common";
import { CurrencyService } from "./currency.service";

@Controller("currency")
export class CurrencyController {
  constructor(private readonly currencyService: CurrencyService) {}

  @Get("rates")
  async getRates() {
    const rates = await this.currencyService.getRates();
    return { ok: true, base: "EUR", rates };
  }

  @Post("refresh")
  async refresh() {
    const result = await this.currencyService.refreshRates();
    return { ok: true, ...result };
  }
}
