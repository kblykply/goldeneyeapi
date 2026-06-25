import { Controller, Post, Body } from "@nestjs/common";
import { IsString, IsArray, IsInt, Min, ArrayNotEmpty } from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { OtpService } from "../otp/otp.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { TeamService } from "../team/team.service";
import { SkipAuth } from "../auth/skip-auth.decorator";

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

@SkipAuth()
@Controller("customer-portal")
export class CustomerPortalController {
  constructor(
    private prisma: PrismaService,
    private otp: OtpService,
    private audit: AuditService,
    private notifs: NotificationsService,
    private team: TeamService,
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
    const contract = await this.prisma.contract.findUnique({
      where: { id: body.contractId },
      select: {
        status: true,
        customerId: true,
        customer: { select: { phoneE164: true } },
        customPaymentPlan: {
          select: {
            installments: { select: { id: true, baseAmountCents: true, paidAmountCents: true } },
          },
        },
      },
    });

    if (!contract) return { ok: false, message: "Sözleşme bulunamadı." };
    if (contract.customer.phoneE164 !== body.phoneE164) {
      return { ok: false, message: "Yetkisiz işlem." };
    }
    if (contract.status !== "APPROVED") {
      return { ok: false, message: "Sözleşme ödenebilir durumda değil." };
    }

    const planInstallments = contract.customPaymentPlan?.installments ?? [];
    const validIds = new Set(planInstallments.map((i) => i.id));
    const allValid = body.installmentIds.every((id) => validIds.has(id));
    if (!allValid) {
      return { ok: false, message: "Geçersiz taksit seçimi." };
    }

    // Use the already-fetched installments to compute totalRemaining — no second DB query
    const selectedInstallments = planInstallments.filter((i) =>
      body.installmentIds.includes(i.id),
    );
    const totalRemaining = selectedInstallments.reduce(
      (sum, i) => sum + (i.baseAmountCents - i.paidAmountCents),
      0,
    );
    if (body.amountCents > totalRemaining) {
      return { ok: false, message: "Ödeme tutarı seçili taksitlerin toplamını aşıyor." };
    }

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

    // Duplicate callback — zaten işlendi
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

    const installments = await this.prisma.customPaymentInstallment.findMany({
      where: { id: { in: transaction.installmentIds } },
      select: { id: true, baseAmountCents: true, paidAmountCents: true, dueDate: true },
      orderBy: { dueDate: "asc" },
    });

    let remaining = transaction.amountCents;
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
            data: {
              posTransactionId: transaction.id,
              installmentId: inst.id,
              amountCents: toPay,
            },
          });

          await tx.customPaymentInstallment.update({
            where: { id: inst.id },
            data: {
              paidAmountCents: newPaid,
              isPaid,
              paidAt: isPaid ? now : undefined,
            },
          });

          allocationLog.push({ installmentId: inst.id, amountCents: toPay, isPaid });
          remaining -= toPay;
        }

        await tx.posTransaction.update({
          where: { id: transaction.id },
          data: { status: "SUCCESS", posReference: body.posReference },
        });

        await this.audit.logWithTx(tx, {
          action: "PAYMENT_COMPLETED",
          entityType: "POS_TRANSACTION",
          entityId: transaction.id,
          contractId: transaction.contractId,
          meta: {
            posReference: body.posReference,
            totalAmountCents: transaction.amountCents,
            allocations: allocationLog,
          },
        });
      });
    } catch (e: any) {
      if (e?.code === "P2002") return { ok: true };
      throw e;
    }

    // Hiyerarşiye bildirim gönder (fire & forget — ödeme yanıtını bloklamaz)
    this.sendPaymentNotifications(transaction.id, transaction.contractId, transaction.amountCents).catch(() => {});

    return { ok: true };
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
