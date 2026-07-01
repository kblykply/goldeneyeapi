import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { VposParams, VposResult } from './payment.types';
import { centsToDecimalString, formatExpiryForVpos, buildXmlBody, parseXmlResponse } from './payment.utils';

@Injectable()
export class ZiraatVposService {
  private readonly logger = new Logger(ZiraatVposService.name);

  private readonly merchantId: string;
  private readonly merchantPassword: string;
  private readonly terminalNo: string;
  private readonly vposUrl: string;
  private readonly currencyCode: string;

  constructor(private config: ConfigService) {
    this.merchantId = this.config.getOrThrow('ZIRAAT_MERCHANT_ID');
    this.merchantPassword = this.config.getOrThrow('ZIRAAT_MERCHANT_PASSWORD');
    this.terminalNo = this.config.getOrThrow('ZIRAAT_TERMINAL_NO');
    this.vposUrl = this.config.getOrThrow('ZIRAAT_VPOS_URL');
    this.currencyCode = this.config.get('ZIRAAT_CURRENCY_CODE', '949');
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

    // CAVV: boş string yerine sadece dolu ise ekle (MC+StatusA durumunda gönderilmemeli)
    if (params.cavv) fields.CAVV = params.cavv;
    // CVV: 3D sonrası opsiyonel, mevcut ise ekle
    if (params.cvv) fields.Cvv = params.cvv;

    // Doküman bölüm 6: VPos POX yöntemi — prmtstr form parametresiyle gönderilir
    const xmlBody = buildXmlBody('VposRequest', fields);

    let xmlText: string;
    try {
      const res = await fetch(this.vposUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ prmtstr: xmlBody }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      xmlText = await res.text();
    } catch (err) {
      this.logger.error('VPos HTTP error', err);
      return { approved: false, responseCode: 'TIMEOUT', responseText: 'VPos bağlantı hatası.' };
    }

    this.logger.debug('VPos response', xmlText);

    let parsed: Record<string, any>;
    try {
      parsed = parseXmlResponse(xmlText);
    } catch {
      this.logger.error('VPos XML parse error', xmlText);
      return { approved: false, responseCode: 'PARSE_ERROR', responseText: 'VPos geçersiz yanıt.' };
    }

    const vposRes = parsed?.VposResponse as Record<string, any> | undefined;
    if (!vposRes) {
      this.logger.error('VPos: VposResponse missing', xmlText);
      return { approved: false, responseCode: 'INVALID', responseText: 'VPos geçersiz yanıt.' };
    }

    const responseCode = String(vposRes.ResultCode ?? vposRes.resultCode ?? '');
    const responseText = String(vposRes.ResultDetail ?? vposRes.resultDetail ?? '');
    const hostReference = String(vposRes.HostReference ?? vposRes.hostReference ?? '');
    // Doküman bölüm 15: Başarılı işlem kodu "0000"
    const approved = responseCode === '0000';

    return { approved, responseCode, responseText, hostReference };
  }
}
