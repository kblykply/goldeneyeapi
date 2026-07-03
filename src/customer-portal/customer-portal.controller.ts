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
import { PrismaService } from "../prisma/prisma.service";
import { OtpService } from "../otp/otp.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { TeamService } from "../team/team.service";
import { SkipAuth } from "../auth/skip-auth.decorator";
import { ZiraatMpiService } from "../payment/ziraat-mpi.service";
import { ZiraatVposService } from "../payment/ziraat-vpos.service";
import {
  calculateMpiHash,
  centsToDecimalString,
  encryptCardToken,
  decryptCardToken,
  detectBrand,
} from "../payment/payment.utils";

// PARes Status (Y/A/N/U) → numeric mdStatus (doküman bölüm 5.8 hash parametreleri)
const PARES_TO_MD_STATUS: Record<string, string> = { Y: "1", A: "4", U: "9", N: "0" };

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

class Payment3dInitDto {
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

  @IsString()
  cardNumber: string;

  @IsString()
  cardExpiry: string; // YYMM — e.g. "2603"

  @IsString()
  cardCvv: string;

  @IsString()
  cardholderName: string;
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

    const customer = await this.prisma.customer.findUnique({
      where: { phoneE164: body.phoneE164 },
      select: {
        id: true,
        fullName: true,
        phoneE164: true,
        contracts: {
          where: { status: "APPROVED" },
          select: {
            id: true,
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
                  orderBy: { dueDate: "asc" },
                },
              },
            },
          },
        },
      },
    });

    if (!customer) return { ok: false, message: "Müşteri bulunamadı." };

    await this.audit.log({
      action: "CUSTOMER_PORTAL_OTP_VERIFIED",
      entityType: "CUSTOMER",
      entityId: customer.id,
      meta: { phoneE164: body.phoneE164, contractCount: customer.contracts.length },
    });

    const contracts = customer.contracts.map((c) => ({
      ...c,
      customPaymentPlan: c.customPaymentPlan
        ? {
            ...c.customPaymentPlan,
            installments: c.customPaymentPlan.installments.map((inst) => ({
              ...inst,
              remainingAmountCents: inst.baseAmountCents - inst.paidAmountCents,
            })),
          }
        : null,
    }));

    return {
      ok: true,
      customer: { fullName: customer.fullName, phoneE164: customer.phoneE164 },
      contracts,
    };
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

    const transaction = await this.prisma.posTransaction.create({
      data: {
        contractId: body.contractId,
        amountCents: body.amountCents,
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
        amountCents: body.amountCents,
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

  @Post("payment-3d-init")
  async payment3dInit(@Body() body: Payment3dInitDto, @Req() req: any) {
    const validation = await this.validateContractForPayment(
      body.contractId,
      body.phoneE164,
      body.installmentIds,
      body.amountCents,
    );
    if (!validation.ok) return validation;

    const cardNumber = body.cardNumber.replace(/\s/g, "");
    const mpiTransactionId = randomUUID().replace(/-/g, "");
    const clientIp = this.getClientIp(req);

    // Kart verisi geçici olarak şifrelenmiş token'da tutulur; işlem sonrası temizlenir
    const cardToken = encryptCardToken(cardNumber, body.cardExpiry, this.cardSecret, body.cardCvv);

    const transaction = await this.prisma.posTransaction.create({
      data: {
        contractId: body.contractId,
        amountCents: body.amountCents,
        installmentIds: body.installmentIds,
        status: "PENDING",
        mpiTransactionId,
        cardBin: cardNumber.substring(0, 6),
        cardLast4: cardNumber.slice(-4),
        cardToken,
      },
      select: { id: true },
    });

    await this.audit.log({
      action: "PAYMENT_3D_INITIATED",
      entityType: "POS_TRANSACTION",
      entityId: transaction.id,
      contractId: body.contractId,
      meta: {
        amountCents: body.amountCents,
        installmentIds: body.installmentIds,
        cardBin: cardNumber.substring(0, 6),
        cardLast4: cardNumber.slice(-4),
      },
    });

    const enrollment = await this.mpi.checkEnrollment({
      pan: cardNumber,
      expiryYYMM: body.cardExpiry,
      amountCents: body.amountCents,
      mpiTransactionId,
      cardholderName: body.cardholderName,
    });

    if (enrollment.status === "E" || enrollment.status === "U") {
      await this.prisma.posTransaction.update({ where: { id: transaction.id }, data: { status: "FAILED" } });
      return { ok: false, message: enrollment.errorMessage ?? "Kart doğrulama başlatılamadı." };
    }

    if (enrollment.status === "N") {
      // Kart 3D'ye kayıtlı değil — Half-Secure VPos çağrısı (doküman bölüm 5.4.3)
      const eci = detectBrand(cardNumber) === "VISA" ? "06" : "02";
      const vposResult = await this.vpos.processPayment({
        pan: cardNumber,
        expiryYYMM: body.cardExpiry,
        amountCents: body.amountCents,
        cvv: body.cardCvv,
        eci,
        cavv: "",
        mpiTransactionId,
        clientIp,
      });

      if (vposResult.approved) {
        await this.allocateAndComplete(transaction.id, body.contractId, body.amountCents, body.installmentIds, vposResult.hostReference ?? "");
        this.sendPaymentNotifications(transaction.id, body.contractId, body.amountCents).catch(() => {});
        return { ok: true, enrolled: false, approved: true, reference: vposResult.hostReference };
      } else {
        await this.prisma.posTransaction.update({
          where: { id: transaction.id },
          data: { status: "FAILED", eci, mdStatus: "0" },
        });
        return { ok: false, enrolled: false, approved: false, message: vposResult.responseText };
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
    @Body() body: ThreeDCallbackDto,
    @Req() req: any,
    @Res() res: any,
  ) {
    const frontendUrl = this.config.get("FRONTEND_URL", "");
    const redirectFail = (code: string) => res.redirect(`${frontendUrl}/payment-tracking?status=failed&code=${encodeURIComponent(code)}`);
    const redirectOk = (ref: string) => res.redirect(`${frontendUrl}/payment-tracking?status=success&ref=${encodeURIComponent(ref)}`);

    if (!transactionId) return redirectFail("NO_TRANSACTION");

    const transaction = await this.prisma.posTransaction.findFirst({
      where: { mpiTransactionId: transactionId },
      select: { id: true, amountCents: true, installmentIds: true, status: true, contractId: true, mpiTransactionId: true, cardToken: true },
    });

    if (!transaction) return redirectFail("NOT_FOUND");
    if (transaction.status !== "PENDING") {
      return transaction.status === "SUCCESS"
        ? redirectOk(transaction.id)
        : redirectFail("ALREADY_FAILED");
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
    const echoedAmount: string | undefined = rawBody.PurchaseAmount ?? rawBody.purchaseAmount;
    const echoedCurrency: string | undefined =
      rawBody.PurchCurrency ?? rawBody.Currency ?? rawBody.currency;
    const expectedAmount = centsToDecimalString(transaction.amountCents);

    // Tutar bütünlüğü hash'ten bağımsız da doğrulanır
    if (echoedAmount && Number(echoedAmount) !== Number(expectedAmount)) {
      await this.prisma.posTransaction.update({
        where: { id: transaction.id },
        data: { status: "FAILED", mdStatus, paresStatus, eci, cavv },
      });
      return redirectFail("AMOUNT_MISMATCH");
    }

    if (incomingHash) {
      const expectedHash = calculateMpiHash({
        verifyEnrollmentRequestId: transaction.mpiTransactionId ?? transactionId,
        merchantId: this.mpi.getMerchantId(),
        currencyCode: echoedCurrency ?? this.mpi.getVposCurrencyCode(),
        amount: echoedAmount ?? expectedAmount,
        eci,
        cavv,
        mdStatus,
        paresStatus,
        mpiPassword: this.mpi.getMpiPassword(),
      });
      if (expectedHash !== incomingHash) {
        const sanitized = Object.fromEntries(
          Object.entries(rawBody).map(([k, v]) =>
            /pan|card/i.test(k) ? [k, "***"] : [k, v],
          ),
        );
        this.logger.error(
          `3D callback hash mismatch. expected=${expectedHash} received=${incomingHash} body=${JSON.stringify(sanitized)}`,
        );
        await this.prisma.posTransaction.update({
          where: { id: transaction.id },
          data: { status: "FAILED", mdStatus, paresStatus, eci, cavv },
        });
        return redirectFail("HASH_MISMATCH");
      }
    }

    // Doküman bölüm 5.7: Y ve A başarılı; N durdurulur; U bankaya göre değişir
    if (paresStatus !== "Y" && paresStatus !== "A") {
      await this.prisma.posTransaction.update({
        where: { id: transaction.id },
        data: { status: "FAILED", mdStatus, paresStatus, eci, cavv },
      });
      return redirectFail(`3D_FAILED_${paresStatus || mdStatus}`);
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
        await this.prisma.posTransaction.update({ where: { id: transaction.id }, data: { status: "FAILED" } });
        return redirectFail("CARD_TOKEN_ERROR");
      }
    }

    // Doküman 5.7: Mastercard + Status A → CAVV gönderilmemelidir
    const vposCavv = detectBrand(pan) === "MC" && paresStatus === "A" ? "" : cavv;

    const vposResult = await this.vpos.processPayment({
      pan,
      expiryYYMM,
      amountCents: transaction.amountCents,
      cvv,
      eci,
      cavv: vposCavv,
      mpiTransactionId: transaction.mpiTransactionId ?? transactionId,
      clientIp,
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
      return redirectOk(vposResult.hostReference ?? transaction.id);
    } else {
      await this.prisma.posTransaction.update({
        where: { id: transaction.id },
        data: { status: "FAILED", mdStatus, paresStatus, eci, cavv },
      });
      return redirectFail(vposResult.responseCode);
    }
  }

  // ─── Yardımcı metodlar ───────────────────────────────────────────────────────

  private getClientIp(req: any): string {
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket?.remoteAddress ?? "0.0.0.0";
  }

  private async validateContractForPayment(
    contractId: string,
    phoneE164: string,
    installmentIds: string[],
    amountCents: number,
  ): Promise<
    | { ok: false; message: string }
    | { ok: true; selectedInstallments: Array<{ id: string; baseAmountCents: number; paidAmountCents: number }> }
  > {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: {
        status: true,
        customer: { select: { phoneE164: true } },
        customPaymentPlan: {
          select: {
            installments: { select: { id: true, baseAmountCents: true, paidAmountCents: true } },
          },
        },
      },
    });

    if (!contract) return { ok: false, message: "Sözleşme bulunamadı." };
    if (contract.customer.phoneE164 !== phoneE164) return { ok: false, message: "Yetkisiz işlem." };
    if (contract.status !== "APPROVED") return { ok: false, message: "Sözleşme ödenebilir durumda değil." };

    const planInstallments = contract.customPaymentPlan?.installments ?? [];
    const installmentMap = new Map(planInstallments.map((i) => [i.id, i]));
    const selectedInstallments = installmentIds
      .map((id) => installmentMap.get(id))
      .filter(Boolean) as Array<{ id: string; baseAmountCents: number; paidAmountCents: number }>;

    if (selectedInstallments.length !== installmentIds.length) {
      return { ok: false, message: "Geçersiz taksit seçimi." };
    }

    const totalRemaining = selectedInstallments.reduce((s, i) => s + (i.baseAmountCents - i.paidAmountCents), 0);
    if (amountCents > totalRemaining) return { ok: false, message: "Ödeme tutarı seçili taksitlerin toplamını aşıyor." };

    return { ok: true, selectedInstallments };
  }

  private async allocateAndComplete(
    transactionId: string,
    contractId: string,
    amountCents: number,
    installmentIds: string[],
    posReference: string,
    extra?: { mdStatus?: string; paresStatus?: string; eci?: string; cavv?: string; vposReference?: string },
  ): Promise<void> {
    const installments = await this.prisma.customPaymentInstallment.findMany({
      where: { id: { in: installmentIds } },
      select: { id: true, baseAmountCents: true, paidAmountCents: true, dueDate: true },
      orderBy: { dueDate: "asc" },
    });

    let remaining = amountCents;
    const now = new Date();
    const allocationLog: { installmentId: string; amountCents: number; isPaid: boolean }[] = [];

    try {
      await this.prisma.$transaction(async (tx) => {
        for (const inst of installments) {
          if (remaining <= 0) break;
          const installmentRemaining = inst.baseAmountCents - inst.paidAmountCents;
          if (installmentRemaining <= 0) continue;
          const toPay = Math.min(installmentRemaining, remaining);
          const newPaid = inst.paidAmountCents + toPay;
          const isPaid = newPaid >= inst.baseAmountCents;

          await tx.posAllocation.create({
            data: { posTransactionId: transactionId, installmentId: inst.id, amountCents: toPay },
          });
          await tx.customPaymentInstallment.update({
            where: { id: inst.id },
            data: { paidAmountCents: newPaid, isPaid, paidAt: isPaid ? now : undefined },
          });

          allocationLog.push({ installmentId: inst.id, amountCents: toPay, isPaid });
          remaining -= toPay;
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
      });
    } catch (e: any) {
      if (e?.code === "P2002") return; // Duplike unique constraint — idempotent
      throw e;
    }
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
