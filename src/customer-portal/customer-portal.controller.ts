import { Controller, Post, Body, Query, Req, Res, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  IsString,
  IsArray,
  IsInt,
  Min,
  ArrayNotEmpty,
  IsOptional,
} from "class-validator";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OtpService } from "../otp/otp.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { TeamService } from "../team/team.service";
import { SkipAuth } from "../auth/skip-auth.decorator";
import { ZiraatMpiService } from "../payment/ziraat-mpi.service";
import { ZiraatVposService } from "../payment/ziraat-vpos.service";
import { ExchangeRateService, type EurTryQuote } from "../payment/exchange-rate.service";
import { BankMessageLogService } from "../payment/bank-message-log.service";
import {
  calculateMpiHash,
  centsToDecimalString,
  amountMatchesExpected,
  encryptCardToken,
  decryptCardToken,
  detectBrand,
} from "../payment/payment.utils";
import { CommissionService } from "../commissions/commission.service";
import { verifyPortalToken, createPortalToken, getPortalSecret } from "./portal-token.utils";

// Oturum token'ı ömrü — sitedeki sessionStorage TTL'i (30 dk) ile aynı tutulur
const PORTAL_SESSION_TTL_MS = 30 * 60 * 1000;

// verify-otp ve token-login'in ortak sözleşme seçimi
const PORTAL_CONTRACT_SELECT = {
  id: true,
  status: true,
  unitType: true,
  weekOfYear: true,
  paymentPlan: true,
  basePriceCents: true,
  customPaymentPlan: {
    select: {
      baseTotalCents: true,
      installments: {
        select: {
          id: true,
          label: true,
          dueDate: true,
          baseAmountCents: true,
          paidAmountCents: true,
          isPaid: true,
          paidAt: true,
        },
        orderBy: { dueDate: "asc" as const },
      },
    },
  },
} as const;

// "Bu taksitten ne kadar borç kaldı" — portalın müşteriye gönderdiği
// remainingAmountCents ile tahsilat doğrulaması aynı tanımı kullanır
const remainingCents = (i: { baseAmountCents: number; paidAmountCents: number }) =>
  i.baseAmountCents - i.paidAmountCents;

function mapPortalContracts<
  T extends {
    customPaymentPlan: {
      installments: Array<{ baseAmountCents: number; paidAmountCents: number }>;
    } | null;
  },
>(contracts: T[]) {
  return contracts.map((c) => ({
    ...c,
    customPaymentPlan: c.customPaymentPlan
      ? {
          ...c.customPaymentPlan,
          installments: c.customPaymentPlan.installments.map((inst) => ({
            ...inst,
            remainingAmountCents: remainingCents(inst),
          })),
        }
      : null,
  }));
}

// PARes Status (Y/A/N/U) → numeric mdStatus (doküman bölüm 5.8 hash parametreleri)
const PARES_TO_MD_STATUS: Record<string, string> = { Y: "1", A: "4", U: "9", N: "0" };

// Müşteriye gösterilen hata kategorileri. Banka ret kodu, hash/tutar
// uyuşmazlığı gibi teknik gerekçeler audit log'da kalır; ekrana yalnızca bu
// kategori gider ve site bunu kendi diline çevirir.
type CustomerErrorCode =
  | "CARD_DECLINED"          // Banka işlemi reddetti
  | "THREE_D_FAILED"         // 3D şifre doğrulaması geçilemedi
  | "VERIFICATION_UNAVAILABLE" // Kart doğrulama servisi başlatılamadı
  | "SECURITY_CHECK_FAILED"  // Tutar/hash bütünlük kontrolü
  | "SESSION_EXPIRED"        // İşlem kaydı bulunamadı / kart verisi çözülemedi
  | "ALREADY_PROCESSED"      // İşlem daha önce sonuçlanmış
  | "RATE_UNAVAILABLE"       // Güncel kur alınamadı
  | "QUOTE_EXPIRED"          // Kur teklifi eskidi
  | "STALE_SELECTION"        // Ekrandaki taksit listesi güncel değil
  | "CONTRACT_INVALID";      // Sözleşme/taksit seçimi ödemeye uygun değil

class RequestOtpDto {
  @IsString()
  phoneE164: string;
}

class VerifyOtpDto {
  @IsString()
  phoneE164: string;

  @IsString()
  otp: string;
}

// token-login ve contracts uçlarının ortak gövdesi
class PortalTokenDto {
  @IsString()
  token: string;
}

class InitiatePaymentDto {
  @IsString()
  phoneE164: string;

  @IsString()
  contractId: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  installmentIds: string[];

  @IsInt()
  @Min(1)
  amountCents: number;
}

class PaymentCallbackDto {
  @IsString()
  transactionId: string;

  @IsString()
  posReference: string;

  @IsString()
  status: "SUCCESS" | "FAILED";
}

class Payment3dInitDto extends InitiatePaymentDto {
  // Müşteriye quote'ta gösterilen TL tutar (kuruş). Sunucu kendi hesabıyla
  // birebir karşılaştırır; kur değiştiyse işlem reddedilir — müşteriden
  // onayladığından farklı bir tutar asla çekilmez. Finansal hesapta kullanılmaz.
  @IsInt()
  @Min(1)
  quotedTryCents: number;

  @IsString()
  cardNumber: string;

  @IsString()
  cardExpiry: string; // YYMM — e.g. "2603"

  @IsString()
  cardCvv: string;

  @IsString()
  cardholderName: string;

  @IsOptional()
  @IsString()
  locale?: string;
}

// Ziraat MPI'ın SuccessUrl/FailureUrl'a POST ettiği alanlar (doküman bölüm 5.6)
// Hem büyük hem küçük harf varyantları kabul edilir — banka sürümüne göre değişebilir
class ThreeDCallbackDto {
  @IsOptional() @IsString() Status?: string;   // PARes sonucu: Y/A/N/U
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() mdStatus?: string; // Sayısal durum — bazı sürümlerde gelebilir
  @IsOptional() @IsString() Eci?: string;
  @IsOptional() @IsString() eci?: string;
  @IsOptional() @IsString() Cavv?: string;
  @IsOptional() @IsString() cavv?: string;
  @IsOptional() @IsString() paresStatus?: string;
  @IsOptional() @IsString() ParesStatus?: string;
  @IsOptional() @IsString() PARes?: string;
  @IsOptional() @IsString() MD?: string;
  @IsOptional() @IsString() Hash?: string;
  @IsOptional() @IsString() VerifyEnrollmentRequestId?: string;
}

@SkipAuth()
@Controller("customer-portal")
export class CustomerPortalController {
  private readonly logger = new Logger(CustomerPortalController.name);
  private readonly cardSecret: string;

  constructor(
    private prisma: PrismaService,
    private otp: OtpService,
    private audit: AuditService,
    private notifs: NotificationsService,
    private team: TeamService,
    private mpi: ZiraatMpiService,
    private vpos: ZiraatVposService,
    private fx: ExchangeRateService,
    private bankLog: BankMessageLogService,
    private commissions: CommissionService,
    private config: ConfigService,
  ) {
    this.cardSecret = this.config.getOrThrow("CARD_TOKEN_SECRET");
  }

  @Post("request-otp")
  async requestOtp(@Body() body: RequestOtpDto) {
    const customer = await this.prisma.customer.findUnique({
      where: { phoneE164: body.phoneE164 },
      select: { id: true },
    });

    if (!customer) {
      return { ok: false, message: "Bu telefon numarasına kayıtlı müşteri bulunamadı." };
    }

    await this.otp.requestOtp({ phoneE164: body.phoneE164, purpose: "CUSTOMER_PORTAL" });

    await this.audit.log({
      action: "CUSTOMER_PORTAL_OTP_REQUESTED",
      entityType: "CUSTOMER",
      entityId: customer.id,
      meta: { phoneE164: body.phoneE164 },
    });

    return { ok: true };
  }

  @Post("verify-otp")
  async verifyOtp(@Body() body: VerifyOtpDto) {
    const result = await this.otp.verifyOtp({
      phoneE164: body.phoneE164,
      purpose: "CUSTOMER_PORTAL",
      otp: body.otp,
    });

    if (!result.ok) return { ok: false, message: result.message };

    const loaded = await this.loadPortalCustomer({ phoneE164: body.phoneE164 });
    if (!loaded) return { ok: false, message: "Müşteri bulunamadı." };
    const { id: customerId, ...session } = loaded;

    await this.audit.log({
      action: "CUSTOMER_PORTAL_OTP_VERIFIED",
      entityType: "CUSTOMER",
      entityId: customerId,
      meta: { phoneE164: body.phoneE164, contractCount: session.contracts.length },
    });

    return { ok: true, ...session };
  }

  // Giriş yapmış müşterinin taksit listesini tazeler. Ödeme tamamlandığında
  // sayfa bu ucu çağırır; aksi halde ekranda giriş anındaki eski liste kalır.
  @Post("contracts")
  async refreshContracts(@Body() body: PortalTokenDto) {
    const payload = verifyPortalToken(body.token, getPortalSecret(this.config), "SESSION");
    if (!payload) {
      return { ok: false, code: "SESSION_EXPIRED", message: "Oturum süresi doldu." };
    }

    const loaded = await this.loadPortalCustomer({ id: payload.customerId }, payload.contractId);
    if (!loaded) return { ok: false, message: "Müşteri bulunamadı." };

    const { id: _customerId, ...session } = loaded;
    return { ok: true, ...session };
  }

  // Sunum sonunda satışçının ürettiği kısa ömürlü linkle OTP'siz giriş.
  @Post("token-login")
  async tokenLogin(@Body() body: PortalTokenDto) {
    const payload = verifyPortalToken(body.token, getPortalSecret(this.config), "LINK");

    if (!payload) {
      return { ok: false, message: "Bağlantının süresi dolmuş. Lütfen telefon numaranızla giriş yapın." };
    }

    const loaded = await this.loadPortalCustomer({ id: payload.customerId }, payload.contractId);
    if (!loaded) return { ok: false, message: "Müşteri bulunamadı." };
    const { id: customerId, ...session } = loaded;

    await this.audit.log({
      action: "CUSTOMER_PORTAL_TOKEN_LOGIN",
      entityType: "CUSTOMER",
      entityId: customerId,
      contractId: payload.contractId,
      meta: { phoneE164: session.customer.phoneE164, contractCount: session.contracts.length },
    });

    return { ok: true, ...session };
  }

  @Post("initiate-payment")
  async initiatePayment(@Body() body: InitiatePaymentDto) {
    const validation = await this.validateContractForPayment(
      body.contractId,
      body.phoneE164,
      body.installmentIds,
      body.amountCents,
    );
    if (!validation.ok) return validation;

    // Kaydedilen tutar sunucunun hesabıdır (client'ınki değil)
    const { payableCents } = validation;

    const transaction = await this.prisma.posTransaction.create({
      data: {
        contractId: body.contractId,
        amountCents: payableCents,
        installmentIds: body.installmentIds,
        status: "PENDING",
      },
      select: { id: true },
    });

    await this.audit.log({
      action: "PAYMENT_INITIATED",
      entityType: "POS_TRANSACTION",
      entityId: transaction.id,
      contractId: body.contractId,
      meta: {
        amountCents: payableCents,
        installmentCount: body.installmentIds.length,
        installmentIds: body.installmentIds,
        phoneE164: body.phoneE164,
      },
    });

    return { ok: true, transactionId: transaction.id };
  }

  @Post("payment-callback")
  async paymentCallback(@Body() body: PaymentCallbackDto) {
    const transaction = await this.prisma.posTransaction.findUnique({
      where: { id: body.transactionId },
      select: { id: true, amountCents: true, installmentIds: true, status: true, contractId: true },
    });

    if (!transaction) return { ok: false, message: "İşlem bulunamadı." };

    if (transaction.status !== "PENDING") {
      return { ok: true };
    }

    if (body.status === "FAILED") {
      await this.prisma.posTransaction.update({
        where: { id: transaction.id },
        data: { status: "FAILED", posReference: body.posReference },
      });

      await this.audit.log({
        action: "PAYMENT_FAILED",
        entityType: "POS_TRANSACTION",
        entityId: transaction.id,
        contractId: transaction.contractId,
        meta: {
          posReference: body.posReference,
          amountCents: transaction.amountCents,
        },
      });

      return { ok: true };
    }

    await this.allocateAndComplete(transaction.id, transaction.contractId, transaction.amountCents, transaction.installmentIds, body.posReference);
    this.sendPaymentNotifications(transaction.id, transaction.contractId, transaction.amountCents).catch(() => {});

    return { ok: true };
  }

  // ─── 3D Secure ───────────────────────────────────────────────────────────────

  // Kart formu açılmadan önce çağrılır: seçilen taksitlerin EUR toplamının o anki
  // kurla TL karşılığını döner. Müşteriye "kartınızdan bu kadar TL çekilecektir"
  // bu yanıtla gösterilir; 3d-init aynı kur cache'ini kullandığından tutarlar
  // birebir eşleşir (TTL içinde). Kur alınamazsa ödeme başlatılmaz.
  @Post("payment-quote")
  async paymentQuote(@Body() body: InitiatePaymentDto) {
    const quoted = await this.validateAndQuoteTry(body);
    if (!quoted.ok) return quoted;
    return { ok: true, ...quoted.quote };
  }

  @Post("payment-3d-init")
  async payment3dInit(@Body() body: Payment3dInitDto, @Req() req: any) {
    // Kur sunucuda çekilir ve işlem kaydına kilitlenir; bankaya giden tutar
    // her adımda (MPI, VPos, callback doğrulaması) bu kilitli TL değerdir.
    const quoted = await this.validateAndQuoteTry(body);
    if (!quoted.ok) return quoted;
    const chargedTryCents = quoted.quote.amountTryCents;
    // Kaydedilen ve tahsis edilen EUR tutarı sunucunun hesabıdır (client'ınki değil)
    const payableCents = quoted.payableCents;

    // Müşterinin ekranda onayladığı TL tutar sunucu hesabıyla birebir aynı olmalı;
    // kur bu arada değiştiyse farklı tutar çekmek yerine işlem reddedilir.
    // Güncel teklif yanıtta döner; client yeni bir quote isteği atmadan gösterir.
    if (body.quotedTryCents !== chargedTryCents) {
      return {
        ok: false,
        code: "QUOTE_EXPIRED",
        message: "Kur güncellendi. Lütfen tutarı yeniden onaylayın.",
        ...quoted.quote,
      };
    }

    const cardNumber = body.cardNumber.replace(/\s/g, "");
    const mpiTransactionId = randomUUID().replace(/-/g, "");
    const clientIp = this.getClientIp(req);

    // Kart verisi geçici olarak şifrelenmiş token'da tutulur; işlem sonrası temizlenir
    const cardToken = encryptCardToken(cardNumber, body.cardExpiry, this.cardSecret, body.cardCvv);

    // İşlem kaydına ve audit'e birebir aynı kur alanları yazılır;
    // para birimi etiketi bankaya giden koddan (ZIRAAT_CURRENCY_CODE) türetilir
    const fxFields = {
      chargedCurrency: this.vpos.getCurrencyAlpha(),
      chargedAmountCents: chargedTryCents,
      fxRate: quoted.quote.rate,
      fxRateSource: quoted.quote.rateSource,
      fxRateAt: quoted.quote.rateAt,
    };

    const transaction = await this.prisma.posTransaction.create({
      data: {
        contractId: body.contractId,
        amountCents: payableCents,
        installmentIds: body.installmentIds,
        status: "PENDING",
        mpiTransactionId,
        cardBin: cardNumber.substring(0, 6),
        cardLast4: cardNumber.slice(-4),
        cardToken,
        ...fxFields,
      },
      select: { id: true },
    });

    await this.audit.log({
      action: "PAYMENT_3D_INITIATED",
      entityType: "POS_TRANSACTION",
      entityId: transaction.id,
      contractId: body.contractId,
      meta: {
        amountCents: payableCents,
        ...fxFields,
        installmentIds: body.installmentIds,
        cardBin: cardNumber.substring(0, 6),
        cardLast4: cardNumber.slice(-4),
      },
    });

    const enrollment = await this.mpi.checkEnrollment({
      pan: cardNumber,
      expiryYYMM: body.cardExpiry,
      amountCents: chargedTryCents,
      mpiTransactionId,
      cardholderName: body.cardholderName,
      locale: body.locale,
      posTransactionId: transaction.id,
      contractId: body.contractId,
    });

    if (enrollment.status === "E" || enrollment.status === "U") {
      const code = await this.failTransaction({
        transactionId: transaction.id,
        contractId: body.contractId,
        reasonCode: `ENROLLMENT_${enrollment.status}`,
        customerCode: "VERIFICATION_UNAVAILABLE",
        meta: { bankMessage: enrollment.errorMessage ?? null },
      });
      return { ok: false, code, message: "Kart doğrulama başlatılamadı." };
    }

    if (enrollment.status === "N") {
      // Kart 3D'ye kayıtlı değil — Half-Secure VPos çağrısı (doküman bölüm 5.4.3)
      const eci = detectBrand(cardNumber) === "VISA" ? "06" : "02";
      const vposResult = await this.vpos.processPayment({
        pan: cardNumber,
        expiryYYMM: body.cardExpiry,
        amountCents: chargedTryCents,
        cvv: body.cardCvv,
        eci,
        cavv: "",
        mpiTransactionId,
        clientIp,
        posTransactionId: transaction.id,
        contractId: body.contractId,
      });

      if (vposResult.approved) {
        await this.allocateAndComplete(transaction.id, body.contractId, payableCents, body.installmentIds, vposResult.hostReference ?? "");
        this.sendPaymentNotifications(transaction.id, body.contractId, payableCents).catch(() => {});
        return { ok: true, enrolled: false, approved: true, reference: vposResult.hostReference };
      } else {
        const code = await this.failTransaction({
          transactionId: transaction.id,
          contractId: body.contractId,
          reasonCode: "VPOS_DECLINED_HALF_SECURE",
          customerCode: "CARD_DECLINED",
          fields: { eci, mdStatus: "0" },
          meta: {
            bankResponseCode: vposResult.responseCode,
            bankResponseText: vposResult.responseText,
          },
        });
        return { ok: false, enrolled: false, approved: false, code, message: "Ödeme reddedildi." };
      }
    }

    // Status === 'Y' — Kart 3D'ye kayıtlı, ACS'e yönlendir
    // termUrl: MPI'ın kendi URL'i (doküman 5.5) — frontend bu URL'i ACS formuna koymalı
    return {
      ok: true,
      enrolled: true,
      transactionId: transaction.id,
      acsUrl: enrollment.acsUrl,
      pareq: enrollment.pareq,
      md: enrollment.md,
      termUrl: enrollment.termUrl,
    };
  }

  // Ziraat MPI'ın SuccessUrl/FailureUrl'a yaptığı browser POST (doküman bölüm 5.6)
  @Post("3d-callback")
  async threeDCallback(
    @Query("transactionId") transactionId: string,
    @Query("locale") localeParam: string,
    @Body() body: ThreeDCallbackDto,
    @Req() req: any,
    @Res() res: any,
  ) {
    const frontendUrl = this.config.get("FRONTEND_URL", "");
    // next-intl locale-prefix'li route kullanıyor; prefix olmadan /payment-tracking 404 verir.
    // Banka SuccessUrl/FailureUrl'i aynen geri POST ettiği için locale query'den okunur.
    const allowedLocales = ["tr", "en", "fa", "ru"];
    const locale = allowedLocales.includes(localeParam) ? localeParam : "tr";
    // Ekrana yalnızca müşteri kategorisi gider; teknik gerekçe audit log'da
    const redirectFail = (code: CustomerErrorCode) => res.redirect(`${frontendUrl}/${locale}/payment-tracking?status=failed&code=${encodeURIComponent(code)}`);
    const redirectOk = (ref: string) => res.redirect(`${frontendUrl}/${locale}/payment-tracking?status=success&ref=${encodeURIComponent(ref)}`);

    // İşlem kaydı yoksa FAILED'a çekilecek satır da yok; audit yine de tutulur
    if (!transactionId) {
      await this.audit.log({
        action: "PAYMENT_FAILED",
        entityType: "POS_TRANSACTION",
        entityId: "unknown",
        meta: { reasonCode: "NO_TRANSACTION_ID", customerCode: "SESSION_EXPIRED" },
      });
      return redirectFail("SESSION_EXPIRED");
    }

    const transaction = await this.prisma.posTransaction.findFirst({
      where: { mpiTransactionId: transactionId },
      select: { id: true, amountCents: true, chargedAmountCents: true, installmentIds: true, status: true, contractId: true, mpiTransactionId: true, cardToken: true },
    });

    // Bankanın bize POST ettiği ham sonuç da mutabakat kanıtının parçası;
    // gövde maskelenerek saklanır (PaReq/PARes kısaltılır, kart alanı gizlenir).
    // Gövde serileştirme callback'i düşürmemeli — hata olursa kayıt yine yazılır.
    const callbackStatus = body.Status ?? body.status ?? body.paresStatus ?? body.ParesStatus ?? "";
    let callbackBody: string;
    try {
      callbackBody = new URLSearchParams(req.body ?? {}).toString();
    } catch {
      callbackBody = "[gövde serileştirilemedi]";
    }

    await this.bankLog.record({
      service: "THREE_D_CALLBACK",
      // Bankanın 3D sonucu: Y/A geçti, diğerleri reddedildi; işlem eşleşmediyse hata
      outcome: !transaction
        ? "ERROR"
        : callbackStatus === "Y" || callbackStatus === "A"
          ? "SUCCESS"
          : "DECLINED",
      endpoint: req.originalUrl ?? "/customer-portal/3d-callback",
      requestBody: callbackBody,
      mpiTransactionId: transactionId,
      posTransactionId: transaction?.id,
      contractId: transaction?.contractId,
      resultCode: callbackStatus || body.mdStatus,
      errorMessage: transaction ? undefined : "Eşleşen işlem kaydı bulunamadı",
    });

    if (!transaction) {
      await this.audit.log({
        action: "PAYMENT_FAILED",
        entityType: "POS_TRANSACTION",
        entityId: transactionId,
        meta: { reasonCode: "TRANSACTION_NOT_FOUND", customerCode: "SESSION_EXPIRED", mpiTransactionId: transactionId },
      });
      return redirectFail("SESSION_EXPIRED");
    }

    if (transaction.status !== "PENDING") {
      return transaction.status === "SUCCESS"
        ? redirectOk(transaction.id)
        : redirectFail("ALREADY_PROCESSED");
    }

    // ValidationPipe whitelist DTO dışı alanları siler; bankanın echo'ladığı
    // PurchaseAmount/Currency gibi alanlar için ham gövdeye bakılır
    const rawBody: Record<string, any> = req.body ?? {};
    const paresStatus = body.Status ?? body.status ?? body.paresStatus ?? body.ParesStatus ?? "";
    const eci = body.Eci ?? body.eci ?? "";
    const cavv = body.Cavv ?? body.cavv ?? "";
    const incomingHash = body.Hash ?? "";
    const clientIp = this.getClientIp(req);
    const mdStatus = body.mdStatus ?? PARES_TO_MD_STATUS[paresStatus] ?? "0";

    // Hash, bankanın hesapladığı değerlerle birebir aynı girdilerden üretilmeli:
    // banka callback'te echo'ladıysa onu kullan, yoksa kendi değerimize düş
    const echoedAmount: string | undefined =
      rawBody.PurchAmount ?? rawBody.PurchaseAmount ?? rawBody.purchaseAmount;
    const echoedCurrency: string | undefined =
      rawBody.PurchCurrency ?? rawBody.Currency ?? rawBody.currency;
    // Bankaya giden tutar TL (chargedAmountCents); eski/geçiş kayıtları için amountCents'e düşülür
    const bankAmountCents = transaction.chargedAmountCents ?? transaction.amountCents;
    const expectedAmount = centsToDecimalString(bankAmountCents);

    // Tutar bütünlüğü hash'ten bağımsız da doğrulanır.
    // Not: bazı ACS/MPI sürümleri tutarı TR locale ("1.234,56") ya da küçük birim tam
    // sayı ("10000") formatında echo'layabilir; amountMatchesExpected bu varyantları dener.
    if (echoedAmount && !amountMatchesExpected(echoedAmount, bankAmountCents)) {
      const sanitized = Object.fromEntries(
        Object.entries(rawBody).map(([k, v]) => (/pan|card/i.test(k) ? [k, "***"] : [k, v])),
      );
      this.logger.warn(
        `3D callback amount mismatch. echoed=${echoedAmount} expected=${expectedAmount} bankAmountCents=${bankAmountCents} transactionId=${transaction.id} body=${JSON.stringify(sanitized)}`,
      );
      return redirectFail(
        await this.failTransaction({
          transactionId: transaction.id,
          contractId: transaction.contractId,
          reasonCode: "AMOUNT_MISMATCH",
          customerCode: "SECURITY_CHECK_FAILED",
          fields: { mdStatus, paresStatus, eci, cavv },
          meta: { echoedAmount, expectedAmount, bankAmountCents },
        }),
      );
    }

    if (incomingHash) {
      // Doküman 5.8: VerifyEnrollmentRequestId + HostMerchantNumber + CurrencyCode +
      // Amount + Eci + Cavv + mdstatus + ParesStatus + MPI şifresi → ISO-8859-9 → SHA-256 → Base64.
      // Amount formatı ("100" / "100.00") dokümanda belirsiz; iki aday da denenir.
      const amountCandidates = [...new Set([echoedAmount, expectedAmount].filter(Boolean))] as string[];
      const currencyCandidates = [
        ...new Set([echoedCurrency, this.mpi.getVposCurrencyCode()].filter(Boolean)),
      ] as string[];
      const hashInputs = { mdStatus: rawBody.MdStatus ?? mdStatus, paresStatus, eci, cavv };
      const matched = amountCandidates.some((amount) =>
        currencyCandidates.some(
          (currencyCode) =>
            calculateMpiHash({
              verifyEnrollmentRequestId: transaction.mpiTransactionId ?? transactionId,
              merchantId: this.mpi.getMerchantId(),
              currencyCode,
              amount,
              ...hashInputs,
              mpiPassword: this.mpi.getMpiPassword(),
            }) === incomingHash,
        ),
      );
      if (!matched) {
        const sanitized = Object.fromEntries(
          Object.entries(rawBody).map(([k, v]) =>
            /pan|card/i.test(k) ? [k, "***"] : [k, v],
          ),
        );
        this.logger.warn(
          `3D callback hash mismatch (opsiyonel kontrol, doküman 5.8). received=${incomingHash} body=${JSON.stringify(sanitized)}`,
        );
        // Doküman 5.8: bu hash ZORUNLU değil, ek bütünlük kontrolü ("hesaplanabilmektedir").
        // Bankanın gerçek algoritması dokümandan sapıyor ve üretilemedi; asıl finansal
        // güvence VPos provizyonundaki bağımsız ECI/CAVV doğrulaması + AMOUNT_MISMATCH kontrolü.
        // Formül netleşince ZIRAAT_3D_HASH_ENFORCE=true ile tekrar bloklayıcı yapılabilir.
        const enforce = this.config.get("ZIRAAT_3D_HASH_ENFORCE", "false") === "true";
        if (enforce) {
          return redirectFail(
            await this.failTransaction({
              transactionId: transaction.id,
              contractId: transaction.contractId,
              reasonCode: "HASH_MISMATCH",
              customerCode: "SECURITY_CHECK_FAILED",
              fields: { mdStatus, paresStatus, eci, cavv },
              meta: { receivedHash: incomingHash },
            }),
          );
        }
      }
    }

    // Doküman bölüm 5.7: Y ve A başarılı; N durdurulur; U bankaya göre değişir
    if (paresStatus !== "Y" && paresStatus !== "A") {
      return redirectFail(
        await this.failTransaction({
          transactionId: transaction.id,
          contractId: transaction.contractId,
          reasonCode: `3D_FAILED_${paresStatus || mdStatus}`,
          customerCode: "THREE_D_FAILED",
          fields: { mdStatus, paresStatus, eci, cavv },
        }),
      );
    }

    let pan = "";
    let expiryYYMM = "";
    let cvv: string | undefined;
    if (transaction.cardToken) {
      try {
        const card = decryptCardToken(transaction.cardToken, this.cardSecret);
        pan = card.pan;
        expiryYYMM = card.expiry;
        cvv = card.cvv;
      } catch {
        return redirectFail(
          await this.failTransaction({
            transactionId: transaction.id,
            contractId: transaction.contractId,
            reasonCode: "CARD_TOKEN_ERROR",
            customerCode: "SESSION_EXPIRED",
            fields: { mdStatus, paresStatus, eci, cavv },
          }),
        );
      }
    }

    // Doküman 5.7: Mastercard + Status A → CAVV gönderilmemelidir
    const vposCavv = detectBrand(pan) === "MC" && paresStatus === "A" ? "" : cavv;

    const vposResult = await this.vpos.processPayment({
      pan,
      expiryYYMM,
      amountCents: bankAmountCents,
      cvv,
      eci,
      cavv: vposCavv,
      mpiTransactionId: transaction.mpiTransactionId ?? transactionId,
      clientIp,
      posTransactionId: transaction.id,
      contractId: transaction.contractId,
    });

    if (vposResult.approved) {
      await this.allocateAndComplete(
        transaction.id,
        transaction.contractId,
        transaction.amountCents,
        transaction.installmentIds,
        vposResult.hostReference ?? "",
        { mdStatus, paresStatus, eci, cavv, vposReference: vposResult.hostReference },
      );
      this.sendPaymentNotifications(transaction.id, transaction.contractId, transaction.amountCents).catch(() => {});
      // hostReference boş string dönebilir; ?? yerine || ile transaction.id'ye düş
      return redirectOk(vposResult.hostReference || transaction.id);
    } else {
      return redirectFail(
        await this.failTransaction({
          transactionId: transaction.id,
          contractId: transaction.contractId,
          reasonCode: "VPOS_DECLINED_3D",
          customerCode: "CARD_DECLINED",
          fields: { mdStatus, paresStatus, eci, cavv },
          meta: {
            bankResponseCode: vposResult.responseCode,
            bankResponseText: vposResult.responseText,
          },
        }),
      );
    }
  }

  // ─── Yardımcı metodlar ───────────────────────────────────────────────────────

  private getClientIp(req: any): string {
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket?.remoteAddress ?? "0.0.0.0";
  }

  // verify-otp / token-login / contracts uçlarının ortak veri yüklemesi.
  // Dönen yanıt her üçünde de aynı şekildedir; içindeki sessionToken ile sayfa
  // ödeme sonrası listeyi tazeleyebilir (OTP tekrar istenmez).
  // linkContractId: LINK ile girildiyse oturum token'ında taşınır (audit izi).
  private async loadPortalCustomer(
    where: Prisma.CustomerWhereUniqueInput,
    linkContractId?: string,
  ) {
    const customer = await this.prisma.customer.findUnique({
      where,
      select: {
        id: true,
        fullName: true,
        phoneE164: true,
        contracts: {
          // Onay bekleyen sözleşmelerin taksitleri de listelenir; peşinat
          // ödemesi sözleşmeyi otomatik APPROVED yapar. Yalnızca REJECTED gizlenir.
          where: { status: { not: "REJECTED" as const } },
          select: PORTAL_CONTRACT_SELECT,
        },
      },
    });

    if (!customer) return null;

    const sessionExpiresAt = Date.now() + PORTAL_SESSION_TTL_MS;
    const sessionToken = createPortalToken(
      {
        customerId: customer.id,
        contractId: linkContractId,
        purpose: "SESSION",
        expiresAt: sessionExpiresAt,
      },
      getPortalSecret(this.config),
    );

    return {
      id: customer.id,
      // Oturum ömrünün tek sahibi sunucudur; site kendi süre sabitini tutmaz
      customer: { fullName: customer.fullName, phoneE164: customer.phoneE164 },
      contracts: mapPortalContracts(customer.contracts),
      sessionToken,
      sessionExpiresAt,
    };
  }

  // Başarısız ödemenin tek çıkış noktası: işlem FAILED'a çekilir ve gerekçesi
  // audit log'a yazılır. Teknik detay (banka ret kodu/metni, 3D alanları) burada
  // kalıcılaşır; çağıran yalnızca müşteriye gidecek kategoriyi alır.
  private async failTransaction(params: {
    transactionId: string;
    contractId: string;
    reasonCode: string;
    customerCode: CustomerErrorCode;
    fields?: { mdStatus?: string; paresStatus?: string; eci?: string; cavv?: string };
    meta?: Record<string, any>;
  }): Promise<CustomerErrorCode> {
    const { transactionId, contractId, reasonCode, customerCode, fields, meta } = params;

    await this.prisma.posTransaction.update({
      where: { id: transactionId },
      data: { status: "FAILED", cardToken: null, ...fields },
    });

    await this.audit.log({
      action: "PAYMENT_FAILED",
      entityType: "POS_TRANSACTION",
      entityId: transactionId,
      contractId,
      meta: { reasonCode, customerCode, ...fields, ...meta },
    });

    return customerCode;
  }

  // quote ve 3d-init'in ortak ön adımı: sözleşme doğrulaması ve kur çekimi
  // birbirinden bağımsız olduğundan paralel yürütülür. Kur alınamazsa ödeme
  // başlatılmaz — asla tahmini/varsayılan kurla tahsilat yapılmaz.
  private async validateAndQuoteTry(
    body: InitiatePaymentDto,
  ): Promise<
    | { ok: false; code: CustomerErrorCode; message: string }
    | { ok: true; quote: EurTryQuote; payableCents: number }
  > {
    const [validation, quote] = await Promise.all([
      this.validateContractForPayment(body.contractId, body.phoneE164, body.installmentIds, body.amountCents),
      this.fx.quoteEurCents(body.amountCents),
    ]);
    if (!validation.ok) return validation;
    if (!quote) {
      return {
        ok: false,
        code: "RATE_UNAVAILABLE",
        message: "Güncel kur bilgisi alınamadı. Lütfen kısa süre sonra tekrar deneyin.",
      };
    }

    return { ok: true, quote, payableCents: validation.payableCents };
  }

  private async validateContractForPayment(
    contractId: string,
    phoneE164: string,
    installmentIds: string[],
    amountCents: number,
    // Başarılı sonuçtaki payableCents sunucunun hesabıdır ve tahsilatta
    // kullanılacak tek tutardır — client'ın gönderdiği değer kaydedilmez.
  ): Promise<
    { ok: false; code: CustomerErrorCode; message: string } | { ok: true; payableCents: number }
  > {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: {
        status: true,
        customer: { select: { phoneE164: true } },
        customPaymentPlan: {
          select: {
            // Yalnızca ödenmek istenen taksitler çekilir; uzun planlarda tüm
            // satırları taşımaya gerek yok. Plan dışı bir id zaten eşleşmez ve
            // aşağıdaki uzunluk kontrolüne takılır.
            installments: {
              where: { id: { in: installmentIds } },
              select: { id: true, baseAmountCents: true, paidAmountCents: true },
            },
          },
        },
      },
    });

    const invalid = (message: string) =>
      ({ ok: false as const, code: "CONTRACT_INVALID" as const, message });
    // Ekrandaki liste sunucudaki gerçekle uyuşmuyor — sayfa listeyi tazeleyip
    // müşteriden seçimi gözden geçirmesini ister.
    const stale = (message: string) =>
      ({ ok: false as const, code: "STALE_SELECTION" as const, message });

    if (!contract) return invalid("Sözleşme bulunamadı.");
    if (contract.customer.phoneE164 !== phoneE164) return invalid("Yetkisiz işlem.");
    // Onay bekleyen sözleşmelerde de tahsilat yapılır (peşinat ödemesi
    // sözleşmeyi otomatik onaylar); yalnızca reddedilmiş sözleşme ödenemez.
    if (contract.status === "REJECTED") return invalid("Sözleşme ödenebilir durumda değil.");

    const selected = contract.customPaymentPlan?.installments ?? [];

    // Plana ait olmayan ya da tekrar eden id — gerçek bir seçim hatası
    if (selected.length !== new Set(installmentIds).size) {
      return invalid("Geçersiz taksit seçimi.");
    }

    // Bu arada kapanmış taksit seçilmişse liste bayattır
    if (selected.some((i) => remainingCents(i) <= 0)) {
      return stale("Seçtiğiniz taksitlerden biri bu arada ödenmiş.");
    }

    // Tahsil edilecek tutarın tek kaynağı sunucudur; client'ın gönderdiği değer
    // yalnızca "müşteri ekranda bunu onayladı" teyididir. Eşleşmiyorsa ekrandaki
    // liste güncel değil demektir ve tahsilat yapılmaz.
    const payableCents = selected.reduce((s, i) => s + remainingCents(i), 0);
    if (amountCents !== payableCents) {
      return stale("Taksit tutarları güncellenmiş.");
    }

    return { ok: true, payableCents };
  }

  private async allocateAndComplete(
    transactionId: string,
    contractId: string,
    amountCents: number,
    installmentIds: string[],
    posReference: string,
    extra?: { mdStatus?: string; paresStatus?: string; eci?: string; cavv?: string; vposReference?: string },
  ): Promise<void> {
    // Okuma transaction dışında: satır kilidini gereksiz yere uzun tutmamak için.
    // Araya başka bir tahsilat girerse aşağıdaki koşullu güncelleme yakalar.
    const installments = await this.prisma.customPaymentInstallment.findMany({
      where: { id: { in: installmentIds } },
      select: { id: true, baseAmountCents: true, paidAmountCents: true, dueDate: true },
      orderBy: { dueDate: "asc" },
    });

    let remaining = amountCents;
    const now = new Date();
    const allocationLog: { installmentId: string; amountCents: number; isPaid: boolean }[] = [];
    let autoApproved = false;

    try {
      await this.prisma.$transaction(async (tx) => {
        const allocations: { posTransactionId: string; installmentId: string; amountCents: number }[] = [];

        for (const inst of installments) {
          if (remaining <= 0) break;
          const installmentRemaining = remainingCents(inst);
          if (installmentRemaining <= 0) continue;
          const toPay = Math.min(installmentRemaining, remaining);
          const newPaid = inst.paidAmountCents + toPay;
          const isPaid = newPaid >= inst.baseAmountCents;

          // paidAmountCents okuduğumuz değerde kalmışsa güncellenir; araya başka
          // bir tahsilat girdiyse count 0 döner ve tüm işlem geri alınır.
          const { count } = await tx.customPaymentInstallment.updateMany({
            where: { id: inst.id, paidAmountCents: inst.paidAmountCents },
            data: { paidAmountCents: newPaid, isPaid, paidAt: isPaid ? now : undefined },
          });
          if (count !== 1) {
            throw new Error(`Taksit ${inst.id} eşzamanlı olarak değişti — tahsis geri alındı`);
          }

          allocations.push({ posTransactionId: transactionId, installmentId: inst.id, amountCents: toPay });
          allocationLog.push({ installmentId: inst.id, amountCents: toPay, isPaid });
          remaining -= toPay;
        }

        if (allocations.length > 0) {
          await tx.posAllocation.createMany({ data: allocations });
        }

        await tx.posTransaction.update({
          where: { id: transactionId },
          data: {
            status: "SUCCESS",
            posReference: posReference || undefined,
            cardToken: null,
            ...Object.fromEntries(
              Object.entries(extra ?? {}).filter(([, v]) => v !== undefined),
            ),
          },
        });

        await this.audit.logWithTx(tx, {
          action: "PAYMENT_COMPLETED",
          entityType: "POS_TRANSACTION",
          entityId: transactionId,
          contractId,
          meta: {
            posReference,
            totalAmountCents: amountCents,
            allocations: allocationLog,
            ...(extra ?? {}),
          },
        });

        autoApproved = await this.autoApproveIfDepositPaid(tx, contractId, transactionId);
      });
    } catch (e: any) {
      if (e?.code === "P2002") return; // Duplike unique constraint — idempotent
      throw e;
    }

    // Komisyon hesabı APPROVED durumunu şart koştuğundan transaction commit
    // edildikten sonra çağrılır. Tahsilat kesinleşmiştir; buradaki bir hata
    // ödemeyi geri almaz, yalnızca loglanır (yetkili onayı gibi idempotent —
    // sonraki bir onay/ödeme denemesi komisyonları tamamlar).
    if (autoApproved) {
      try {
        await this.commissions.calculateForApprovedContract(contractId);
      } catch (e) {
        this.logger.error(`Otomatik onay sonrası komisyon hesabı başarısız (contract ${contractId})`, e as Error);
      }
      this.sendAutoApprovalNotifications(contractId).catch(() => {});
    }
  }

  // Peşinat (planın en erken vadeli taksiti) tamamen ödendiyse sözleşmeyi
  // yetkili onayı beklemeden APPROVED durumuna geçirir. Peşinat etiketle değil
  // vade sırasıyla tanınır — etiketler satış ekranında düzenlenebilir.
  // approvedById boş bırakılır: onay bir kullanıcıya değil sisteme aittir.
  private async autoApproveIfDepositPaid(
    tx: Prisma.TransactionClient,
    contractId: string,
    transactionId: string,
  ): Promise<boolean> {
    const contract = await tx.contract.findUnique({
      where: { id: contractId },
      select: {
        status: true,
        customPaymentPlan: {
          select: {
            installments: {
              select: { id: true, isPaid: true },
              orderBy: { dueDate: "asc" as const },
              take: 1,
            },
          },
        },
      },
    });

    if (!contract) return false;
    if (contract.status === "APPROVED" || contract.status === "REJECTED") return false;

    const deposit = contract.customPaymentPlan?.installments[0];
    if (!deposit?.isPaid) return false;

    await tx.contract.update({
      where: { id: contractId },
      data: { status: "APPROVED" },
    });

    await this.audit.logWithTx(tx, {
      action: "CONTRACT_AUTO_APPROVED",
      entityType: "CONTRACT",
      entityId: contractId,
      contractId,
      meta: {
        reason: "DEPOSIT_PAID",
        previousStatus: contract.status,
        depositInstallmentId: deposit.id,
        posTransactionId: transactionId,
      },
    });

    return true;
  }

  // Peşinat ödemesiyle otomatik onaylanan sözleşmeyi satışçı zincirine duyurur
  private async sendAutoApprovalNotifications(contractId: string): Promise<void> {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: {
        salespersonId: true,
        customer: { select: { fullName: true } },
      },
    });

    if (!contract) return;

    const title = "Sözleşme Onaylandı";
    const body = `${contract.customer.fullName} — peşinat ödemesiyle sözleşme otomatik onaylandı`;

    const recipientIds = await this.team.getAncestorIds(contract.salespersonId);

    await Promise.all(
      recipientIds.map((recipientId) =>
        this.notifs.create({
          type: "PAYMENT_RECEIVED",
          title,
          body,
          actorId: contract.salespersonId,
          recipientId,
          entityId: contractId,
          entityType: "CONTRACT",
        }),
      ),
    );
  }

  private async sendPaymentNotifications(
    posTransactionId: string,
    contractId: string,
    amountCents: number,
  ): Promise<void> {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: {
        salespersonId: true,
        customer: { select: { fullName: true } },
      },
    });

    if (!contract) return;

    const amountEur = (amountCents / 100).toFixed(2);
    const title = "Ödeme Alındı";
    const body = `${contract.customer.fullName} — ${amountEur} EUR ödeme gerçekleşti`;

    const recipientIds = await this.team.getAncestorIds(contract.salespersonId);

    await Promise.all(
      recipientIds.map((recipientId) =>
        this.notifs.create({
          type: "PAYMENT_RECEIVED",
          title,
          body,
          actorId: contract.salespersonId,
          recipientId,
          entityId: posTransactionId,
          entityType: "POS_TRANSACTION",
        }),
      ),
    );
  }
}
