import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnrollmentParams, EnrollmentResult } from './payment.types';
import {
  detectBrandName,
  centsToDecimalString,
  parseXmlResponse,
} from './payment.utils';
import { BankMessageLogService } from './bank-message-log.service';

@Injectable()
export class ZiraatMpiService {
  private readonly logger = new Logger(ZiraatMpiService.name);

  private readonly merchantId: string;
  private readonly merchantPassword: string;
  private readonly mpiPassword: string;
  private readonly mpiUrl: string;
  private readonly mpiCurrencyCode: string;
  private readonly vposCurrencyCode: string;
  private readonly appBaseUrl: string;

  constructor(
    private config: ConfigService,
    private bankLog: BankMessageLogService,
  ) {
    this.merchantId = this.config.getOrThrow('ZIRAAT_MERCHANT_ID');
    this.merchantPassword = this.config.getOrThrow('ZIRAAT_MERCHANT_PASSWORD');
    this.mpiPassword = this.config.getOrThrow('ZIRAAT_MPI_PASSWORD');
    this.mpiUrl = this.config.getOrThrow('ZIRAAT_MPI_URL');
    this.mpiCurrencyCode = this.config.get('ZIRAAT_MPI_CURRENCY_CODE', '840');
    this.vposCurrencyCode = this.config.get('ZIRAAT_CURRENCY_CODE', '949');
    this.appBaseUrl = this.config.getOrThrow('APP_BASE_URL');
  }

  async checkEnrollment(params: EnrollmentParams): Promise<EnrollmentResult> {
    // locale, banka SuccessUrl/FailureUrl'i aynen geri POST ettiği için callback'te
    // @Query ile geri okunur; dönüş yönlendirmesi doğru dil prefix'iyle yapılır
    const localeParam = params.locale ? `&locale=${encodeURIComponent(params.locale)}` : "";
    const callbackUrl = `${this.appBaseUrl}/customer-portal/3d-callback?transactionId=${params.mpiTransactionId}${localeParam}`;

    const form = new URLSearchParams({
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

    // Gövde maskelenerek saklanır (bank-message.mask.ts); ham hali DB'ye gitmez
    const logBase = {
      service: 'MPI_ENROLLMENT' as const,
      endpoint: this.mpiUrl,
      requestBody: form.toString(),
      posTransactionId: params.posTransactionId,
      mpiTransactionId: params.mpiTransactionId,
      contractId: params.contractId,
    };
    const startedAt = Date.now();

    let xmlText: string;
    let httpStatus: number | undefined;
    try {
      const res = await fetch(this.mpiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/xml, application/xml',
          'User-Agent': 'Mozilla/5.0 (compatible; GoldeneyeAPI/1.0)',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      httpStatus = res.status;
      xmlText = await res.text();
    } catch (err: any) {
      this.logger.error('MPI enrollment HTTP error', err);
      await this.bankLog.record({
        ...logBase,
        outcome: 'ERROR',
        durationMs: Date.now() - startedAt,
        errorMessage: err?.message ?? 'MPI bağlantı hatası',
      });
      return { status: 'E', errorMessage: 'MPI bağlantı hatası.' };
    }

    const durationMs = Date.now() - startedAt;
    const failed = async (errorMessage: string): Promise<EnrollmentResult> => {
      await this.bankLog.record({
        ...logBase,
        outcome: 'ERROR',
        durationMs,
        httpStatus,
        responseBody: xmlText,
        errorMessage,
      });
      return { status: 'E', errorMessage: 'MPI geçersiz yanıt.' };
    };

    let parsed: Record<string, any>;
    try {
      parsed = parseXmlResponse(xmlText);
    } catch {
      this.logger.error('MPI enrollment XML parse error');
      return failed('MPI yanıtı ayrıştırılamadı');
    }

    const veRes = (parsed?.IPaySecure?.Message?.VERes ?? parsed?.VERes) as Record<string, any> | undefined;
    if (!veRes) {
      this.logger.error('MPI enrollment: VERes missing in response');
      return failed('VERes alanı yanıtta yok');
    }

    const status = String(veRes.Status ?? veRes.status ?? 'E') as 'Y' | 'N' | 'U' | 'E';
    const errorCode = String(veRes.ErrorCode ?? veRes.errorCode ?? '');
    const errorMessage = String(veRes.ErrorMessage ?? veRes.errorMessage ?? '');

    // Y = 3D'ye kayıtlı, N = kayıtsız (ikisi de bankanın geçerli iş yanıtı);
    // U/E ise doğrulama yapılamadı
    await this.bankLog.record({
      ...logBase,
      outcome: status === 'Y' || status === 'N' ? 'SUCCESS' : 'DECLINED',
      durationMs,
      httpStatus,
      responseBody: xmlText,
      resultCode: errorCode || `STATUS_${status}`,
      resultText: errorMessage || undefined,
    });

    if (status === 'Y') {
      return {
        status: 'Y',
        acsUrl: veRes.ACSUrl ?? veRes.acsUrl,
        pareq: veRes.PaReq ?? veRes.PAReq ?? veRes.pareq,
        md: veRes.MD ?? veRes.md,
        termUrl: veRes.TermUrl ?? veRes.termUrl,
      };
    }

    return { status, errorCode, errorMessage };
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
