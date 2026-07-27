import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../cache/cache.service';
import { parseXmlResponse } from './payment.utils';

export interface EurTryRate {
  rate: number; // 1 EUR = rate TRY
  source: string; // ör. "TCMB_FOREX_SELLING"
  fetchedAt: Date;
}

export interface EurTryQuote {
  amountEurCents: number;
  amountTryCents: number;
  rate: number;
  rateSource: string;
  rateAt: Date;
}

const CACHE_KEY = 'fx:eur-try-tcmb';

// Kur her zaman sunucuda çekilir; client'tan gelen hiçbir kur/TL tutarı
// finansal hesapta kullanılmaz. TCMB today.xml hafta sonu/tatilde son iş
// gününün kurunu servis eder — bu, TL karşılığı tahsilatta kabul gören pratiktir.
// Not: CurrencyService'teki genel kur tablosundan ayrıdır; banka tahsilatı
// özellikle TCMB döviz satış kurunu gerektirdiği için kaynağı sabittir.
@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);

  private readonly url: string;
  private readonly cacheTtlMs: number;
  private readonly staleLimitMs: number;

  // TCMB erişilemediğinde staleLimit içinde kullanılacak son geçerli kur
  private lastGood: EurTryRate | null = null;

  constructor(
    private config: ConfigService,
    private cache: CacheService,
  ) {
    this.url = this.config.get('TCMB_RATES_URL', 'https://www.tcmb.gov.tr/kurlar/today.xml');
    this.cacheTtlMs = Number(this.config.get('FX_CACHE_TTL_MS', 10 * 60 * 1000));
    this.staleLimitMs = Number(this.config.get('FX_STALE_LIMIT_MS', 24 * 60 * 60 * 1000));
  }

  // Seçilen EUR tutarın o anki kurla TL karşılığı. EUR→TRY politikasının tek
  // noktası: yuvarlama (en yakın kuruş) ve kur kaynağı burada belirlenir; tüm
  // akış (quote, MPI, VPos, callback karşılaştırması) bu değeri kullanmalıdır.
  // Kur alınamazsa null — asla tahmini/varsayılan kurla tahsilat yapılmaz.
  async quoteEurCents(amountEurCents: number): Promise<EurTryQuote | null> {
    const fx = await this.getEurTrySellRate();
    if (!fx) return null;
    return {
      amountEurCents,
      amountTryCents: Math.round(amountEurCents * fx.rate),
      rate: fx.rate,
      rateSource: fx.source,
      rateAt: fx.fetchedAt,
    };
  }

  // Cache TTL'i içinde aynı kur döner ve eşzamanlı istekler tek TCMB çağrısında
  // birleşir (CacheService in-flight dedupe); böylece quote ve 3d-init aynı kuru
  // kullanır. TCMB'ye ulaşılamazsa staleLimit'i aşmamış son kur, o da yoksa null.
  async getEurTrySellRate(): Promise<EurTryRate | null> {
    const fresh = await this.cache.getOrSet<EurTryRate | undefined>(
      CACHE_KEY,
      this.cacheTtlMs,
      () => this.fetchFromTcmb(),
    );
    if (fresh) {
      this.lastGood = fresh;
      return fresh;
    }

    if (this.lastGood && Date.now() - this.lastGood.fetchedAt.getTime() < this.staleLimitMs) {
      this.logger.warn(
        `TCMB erişilemedi; ${this.lastGood.fetchedAt.toISOString()} tarihli son kur kullanılıyor (${this.lastGood.rate})`,
      );
      return this.lastGood;
    }

    return null;
  }

  // Başarısızlıkta undefined döner — CacheService undefined'ı cache'lemediği
  // için hata TTL boyunca yapışıp kalmaz, sonraki istek yeniden dener.
  private async fetchFromTcmb(): Promise<EurTryRate | undefined> {
    let xmlText: string;
    try {
      const res = await fetch(this.url, {
        headers: { Accept: 'application/xml, text/xml' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        this.logger.error(`TCMB kur isteği ${res.status} döndü`);
        return undefined;
      }
      xmlText = await res.text();
    } catch (err) {
      this.logger.error('TCMB kur isteği başarısız', err);
      return undefined;
    }

    try {
      const parsed = parseXmlResponse(xmlText);
      const currencies = parsed?.Tarih_Date?.Currency;
      const list: any[] = Array.isArray(currencies) ? currencies : [currencies].filter(Boolean);
      const eur = list.find((c) => c?.['@_Kod'] === 'EUR' || c?.['@_CurrencyCode'] === 'EUR');
      const raw = eur?.ForexSelling;
      const rate = Number(String(raw ?? '').replace(',', '.'));
      if (!Number.isFinite(rate) || rate <= 0) {
        this.logger.error(`TCMB EUR ForexSelling parse edilemedi: ${raw}`);
        return undefined;
      }
      return { rate, source: 'TCMB_FOREX_SELLING', fetchedAt: new Date() };
    } catch (err) {
      this.logger.error('TCMB kur XML parse hatası', err);
      return undefined;
    }
  }
}
