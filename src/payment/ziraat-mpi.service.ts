import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnrollmentParams, EnrollmentResult } from './payment.types';
import {
  detectBrandName,
  centsToDecimalString,
  buildXmlBody,
  parseXmlResponse,
} from './payment.utils';

@Injectable()
export class ZiraatMpiService {
  private readonly logger = new Logger(ZiraatMpiService.name);

  private readonly merchantId: string;
  private readonly merchantPassword: string;
  private readonly mpiPassword: string;
  private readonly mpiUrl: string;
  private readonly mpiCurrencyCode: string; // Test=840 (USD); Prod=949 (TL)
  private readonly vposCurrencyCode: string; // Always 949 for VPos
  private readonly appBaseUrl: string;

  constructor(private config: ConfigService) {
    this.merchantId = this.config.getOrThrow('ZIRAAT_MERCHANT_ID');
    this.merchantPassword = this.config.getOrThrow('ZIRAAT_MERCHANT_PASSWORD');
    this.mpiPassword = this.config.getOrThrow('ZIRAAT_MPI_PASSWORD');
    this.mpiUrl = this.config.getOrThrow('ZIRAAT_MPI_URL');
    // Doküman: test ortamında MPI enrollment için Currency=840 (USD) gönderilmeli
    this.mpiCurrencyCode = this.config.get('ZIRAAT_MPI_CURRENCY_CODE', '840');
    this.vposCurrencyCode = this.config.get('ZIRAAT_CURRENCY_CODE', '949');
    this.appBaseUrl = this.config.getOrThrow('APP_BASE_URL');
  }

  async checkEnrollment(params: EnrollmentParams): Promise<EnrollmentResult> {
    const callbackUrl = `${this.appBaseUrl}/customer-portal/3d-callback?transactionId=${params.mpiTransactionId}`;

    const xmlBody = buildXmlBody('VEReq', {
      MerchantId: this.merchantId,
      MerchantPassword: this.merchantPassword,
      VerifyEnrollmentRequestId: params.mpiTransactionId,
      Pan: params.pan,
      ExpiryDate: params.expiryYYMM,
      PurchaseAmount: centsToDecimalString(params.amountCents),
      Currency: this.mpiCurrencyCode,
      BrandName: detectBrandName(params.pan),
      SuccessUrl: callbackUrl,
      FailureUrl: callbackUrl,
      ...(params.cardholderName ? { CardHolderName: params.cardholderName } : {}),
    });

    let xmlText: string;
    try {
      const res = await fetch(this.mpiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8' },
        body: xmlBody,
        signal: AbortSignal.timeout(10_000),
      });
      xmlText = await res.text();
    } catch (err) {
      this.logger.error('MPI enrollment HTTP error', err);
      return { status: 'E', errorMessage: 'MPI bağlantı hatası.' };
    }

    this.logger.debug('MPI enrollment response', xmlText);

    let parsed: Record<string, any>;
    try {
      parsed = parseXmlResponse(xmlText);
    } catch {
      this.logger.error('MPI enrollment XML parse error', xmlText);
      return { status: 'E', errorMessage: 'MPI geçersiz yanıt.' };
    }

    // Doküman yanıt yapısı: <IPaySecure><Message ID="..."><VERes>...</VERes></Message></IPaySecure>
    const veRes = (parsed?.IPaySecure?.Message?.VERes ?? parsed?.VERes) as Record<string, any> | undefined;
    if (!veRes) {
      this.logger.error('MPI enrollment: VERes missing in response', xmlText);
      return { status: 'E', errorMessage: 'MPI geçersiz yanıt.' };
    }

    const status = String(veRes.Status ?? veRes.status ?? 'E') as 'Y' | 'N' | 'U' | 'E';

    if (status === 'Y') {
      return {
        status: 'Y',
        acsUrl: veRes.ACSUrl ?? veRes.acsUrl,
        pareq: veRes.PaReq ?? veRes.PAReq ?? veRes.pareq,
        md: veRes.MD ?? veRes.md,
        // TermUrl in doküman: MPI'ın kendi URL'i — ACS formu bu URL'e POST eder
        termUrl: veRes.TermUrl ?? veRes.termUrl,
      };
    }

    return {
      status,
      errorCode: String(veRes.ErrorCode ?? veRes.errorCode ?? ''),
      errorMessage: String(veRes.ErrorMessage ?? veRes.errorMessage ?? ''),
    };
  }

  getMerchantId(): string {
    return this.merchantId;
  }

  getVposCurrencyCode(): string {
    return this.vposCurrencyCode;
  }

  getMpiCurrencyCode(): string {
    return this.mpiCurrencyCode;
  }

  getMpiPassword(): string {
    return this.mpiPassword;
  }
}
