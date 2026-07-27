import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { VposParams, VposResult } from './payment.types';
import { centsToDecimalString, formatExpiryForVpos, buildXmlBody, parseXmlResponse } from './payment.utils';
import { BankMessageLogService } from './bank-message-log.service';

@Injectable()
export class ZiraatVposService {
  private readonly logger = new Logger(ZiraatVposService.name);

  private readonly merchantId: string;
  private readonly merchantPassword: string;
  private readonly terminalNo: string;
  private readonly vposUrl: string;
  private readonly currencyCode: string;

  constructor(
    private config: ConfigService,
    private bankLog: BankMessageLogService,
  ) {
    this.merchantId = this.config.getOrThrow('ZIRAAT_MERCHANT_ID');
    this.merchantPassword = this.config.getOrThrow('ZIRAAT_MERCHANT_PASSWORD');
    this.terminalNo = this.config.getOrThrow('ZIRAAT_TERMINAL_NO');
    this.vposUrl = this.config.getOrThrow('ZIRAAT_VPOS_URL');
    this.currencyCode = this.config.get('ZIRAAT_CURRENCY_CODE', '949');
  }

  // İşlem kayıtlarındaki para birimi etiketi bankaya giden sayısal koddan türetilir;
  // terminal para birimi env'den değişirse kayıtlar otomatik doğru etiketlenir.
  private static readonly CURRENCY_ALPHA: Record<string, string> = {
    '949': 'TRY',
    '978': 'EUR',
    '840': 'USD',
  };

  getCurrencyAlpha(): string {
    return ZiraatVposService.CURRENCY_ALPHA[this.currencyCode] ?? this.currencyCode;
  }

  async processPayment(params: VposParams): Promise<VposResult> {
    const fields: Record<string, string> = {
      MerchantId: this.merchantId,
      Password: this.merchantPassword,
      TerminalNo: this.terminalNo,
      Pan: params.pan,
      Expiry: formatExpiryForVpos(params.expiryYYMM),
      CurrencyAmount: centsToDecimalString(params.amountCents),
      CurrencyCode: this.currencyCode,
      TransactionType: 'Sale',
      ECI: params.eci,
      MpiTransactionId: params.mpiTransactionId,
      ClientIp: params.clientIp,
      TransactionDeviceSource: '0',
    };

    if (params.cavv) fields.CAVV = params.cavv;
    if (params.cvv) fields.Cvv = params.cvv;
    const xmlBody = buildXmlBody('VposRequest', fields);

    // Gövde maskelenerek saklanır (bank-message.mask.ts); ham hali DB'ye gitmez
    const logBase = {
      service: 'VPOS_PAYMENT' as const,
      endpoint: this.vposUrl,
      requestBody: xmlBody,
      posTransactionId: params.posTransactionId,
      mpiTransactionId: params.mpiTransactionId,
      contractId: params.contractId,
    };
    const startedAt = Date.now();

    let xmlText: string;
    let httpStatus: number | undefined;
    try {
      const res = await fetch(this.vposUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ prmstr: xmlBody }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      httpStatus = res.status;
      xmlText = await res.text();
    } catch (err: any) {
      this.logger.error('VPos HTTP error', err);
      await this.bankLog.record({
        ...logBase,
        outcome: 'ERROR',
        durationMs: Date.now() - startedAt,
        resultCode: 'TIMEOUT',
        errorMessage: err?.message ?? 'VPos bağlantı hatası',
      });
      return { approved: false, responseCode: 'TIMEOUT', responseText: 'VPos bağlantı hatası.' };
    }

    const durationMs = Date.now() - startedAt;
    const failed = async (resultCode: string, errorMessage: string): Promise<VposResult> => {
      await this.bankLog.record({
        ...logBase,
        outcome: 'ERROR',
        durationMs,
        httpStatus,
        responseBody: xmlText,
        resultCode,
        errorMessage,
      });
      return { approved: false, responseCode: resultCode, responseText: 'VPos geçersiz yanıt.' };
    };

    let parsed: Record<string, any>;
    try {
      parsed = parseXmlResponse(xmlText);
    } catch {
      this.logger.error('VPos XML parse error');
      return failed('PARSE_ERROR', 'VPos yanıtı ayrıştırılamadı');
    }

    const vposRes = parsed?.VposResponse as Record<string, any> | undefined;
    if (!vposRes) {
      this.logger.error('VPos: VposResponse missing');
      return failed('INVALID', 'VposResponse alanı yanıtta yok');
    }

    const responseCode = String(vposRes.ResultCode ?? vposRes.resultCode ?? '');
    const responseText = String(vposRes.ResultDetail ?? vposRes.resultDetail ?? '');
    const hostReference = String(vposRes.HostReference ?? vposRes.hostReference ?? '');
    const approved = responseCode === '0000';

    await this.bankLog.record({
      ...logBase,
      outcome: approved ? 'SUCCESS' : 'DECLINED',
      durationMs,
      httpStatus,
      responseBody: xmlText,
      resultCode: responseCode,
      resultText: responseText,
      hostReference: hostReference || undefined,
    });

    return { approved, responseCode, responseText, hostReference };
  }
}
