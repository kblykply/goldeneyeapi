import { Controller, Post, Body, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  IsString,
  IsArray,
  IsInt,
  Min,
  ArrayNotEmpty,
} from "class-validator";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OtpService } from "../otp/otp.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { TeamService } from "../team/team.service";
import { SkipAuth } from "../auth/skip-auth.decorator";
import { ExchangeRateService, type EurTryQuote } from "../payment/exchange-rate.service";
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

// Müşteriye gösterilen hata kategorileri. Banka ret kodu, hash/tutar
// uyuşmazlığı gibi teknik gerekçeler audit log'da kalır; ekrana yalnızca bu
// kategori gider ve site bunu kendi diline çevirir.
type CustomerErrorCode =
  | "CARD_DECLINED"          // Banka işlemi reddetti
  | "THREE_D_FAILED"         // 3D şifre doğrulaması geçilemedi
  | "VERIFICATION_UNAVAILABLE" // Kart doğrulama servisi başlatılamadı
  | "SECURITY_CHECK_FAILED"  // Tutar/hash bütünlük kontrolü
  | "SESSION_EXPIRED"        // Portal oturumu doldu / işlem kaydı bulunamadı / kart verisi çözülemedi
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

// token-login, contracts ve ödeme uçlarının ortak gövdesi
class PortalTokenDto {
  @IsString()
  token: string;
}

// Ödeme uçları giriş yapmış müşterinin oturum token'ını taşır; sözleşmenin
// sahibi token'daki müşteriden doğrulanır (telefon numarası tek başına yetmez)
class InitiatePaymentDto extends PortalTokenDto {
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

@SkipAuth()
@Controller("customer-portal")
export class CustomerPortalController {
  private readonly logger = new Logger(CustomerPortalController.name);

  constructor(
    private prisma: PrismaService,
    private otp: OtpService,
    private audit: AuditService,
    private notifs: NotificationsService,
    private team: TeamService,
    private fx: ExchangeRateService,
    private commissions: CommissionService,
    private config: ConfigService,
  ) {}

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

  // Kartlı ödeme uçları (payment-3d-init, 3d-callback) 24.11.2026'da kaldırıldı.
  // PayFlex MPI + VPos modelinde kart numarası sunucumuzdan geçiyor ve 3D dönüşüne
  // kadar saklanıyordu (PCI DSS SAQ D); kart 3D'ye kayıtlı değilse 3D'siz çekim de
  // yapılıyordu. Artık hiçbir uç kart bilgisi kabul etmez. Online ödeme, kartın
  // bankanın sayfasında girildiği PayFlex Ortak Ödeme Sayfası ile yeniden açılacak;
  // kur (payment-quote), taksit eşleştirme ve bildirim yardımcıları onun için korunuyor.

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

  // quote ve 3d-init'in ortak ön adımı: oturum token'ı DB'ye ve TCMB'ye gitmeden
  // önce doğrulanır (yalnızca HMAC); sonra sözleşme doğrulaması ve kur çekimi
  // birbirinden bağımsız olduğundan paralel yürütülür. Kur alınamazsa ödeme
  // başlatılmaz — asla tahmini/varsayılan kurla tahsilat yapılmaz.
  private async validateAndQuoteTry(
    body: InitiatePaymentDto,
  ): Promise<
    | { ok: false; code: CustomerErrorCode; message: string }
    | { ok: true; quote: EurTryQuote; payableCents: number }
  > {
    const session = verifyPortalToken(body.token, getPortalSecret(this.config), "SESSION");
    if (!session) {
      return { ok: false, code: "SESSION_EXPIRED", message: "Oturum süresi doldu." };
    }

    const [validation, quote] = await Promise.all([
      this.validateContractForPayment(body.contractId, session.customerId, body.installmentIds, body.amountCents),
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
    customerId: string,
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
        customerId: true,
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
    if (contract.customerId !== customerId) return invalid("Yetkisiz işlem.");
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
