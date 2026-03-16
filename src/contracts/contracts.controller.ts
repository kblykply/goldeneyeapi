import { Body, Controller, Get, Param, Post, Req, UseGuards, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { PrismaService } from "../prisma/prisma.service";
import { AuthGuard } from "../auth/auth.guard";
import { AuthedUser } from "../auth/auth.types";
import { Request } from "express";
import { IsString, IsArray, IsOptional, IsDateString, IsInt, Min, ValidateNested, IsEmail } from "class-validator";
import { Type } from "class-transformer";
import * as crypto from "crypto";
import { CommissionService } from "../commissions/commission.service";
import { TeamService } from "../team/team.service";
import { SmsService } from "../sms/sms.service";
import { ConfigService } from "@nestjs/config";
import { createClient } from "@supabase/supabase-js";

const PLAN_LABELS: Record<string, string> = {
  PESIN: "Peşin",
  ALTIN: "Altın (6 Ay)",
  TAKSIT_12: "12 Taksit",
};

function hashOtp(otp: string) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

class VerifyOtpDto {
  @IsString()
  otp!: string;
}

class RejectDto {
  @IsString()
  reason!: string;
}

class CreateInstallmentDto {
  @IsDateString()
  dueDate!: string;

  @IsInt()
  @Min(1)
  baseAmountCents!: number;

  @IsString()
  @IsOptional()
  label?: string;
}

class CreateContractFromPresentationDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateInstallmentDto)
  @IsOptional()
  installments?: CreateInstallmentDto[];

  @IsOptional()
  @IsString()
  nationality?: string;

  @IsOptional()
  @IsString()
  passportNumber?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;
}

@Controller("contracts")
@UseGuards(AuthGuard)
export class ContractsController {
  private supabase: ReturnType<typeof createClient>;

  constructor(
    private prisma: PrismaService,
    private commissions: CommissionService,
    private team: TeamService,
    private sms: SmsService,
    private config: ConfigService,
  ) {
    this.supabase = createClient(
      this.config.get<string>("SUPABASE_URL") ?? "",
      this.config.get<string>("SUPABASE_SERVICE_KEY") ?? "",
    );
  }

  /**
   * 1) Presentation'dan Contract oluştur (DRAFT)
   * POST /contracts/from-presentation/:presentationId
   */
  @Post("from-presentation/:presentationId")
  async createFromPresentation(
    @Param("presentationId") presentationId: string,
    @Body() body: CreateContractFromPresentationDto,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const me = req.user;

    const pres = await this.prisma.presentation.findUnique({
      where: { id: presentationId },
      include: { customer: true },
    });

    if (!pres || pres.salespersonId !== me.id) {
      return { ok: false, message: "Sunum bulunamadı" };
    }

    if (!pres.unitType || !pres.weekOfYear || !pres.paymentPlan || !pres.basePriceCents) {
      return { ok: false, message: "Sunum tamamlanmamış (unit/hafta/plan/fiyat eksik)" };
    }

    const existing = await this.prisma.contract.findFirst({
      where: { presentationId: pres.id },
      select: { id: true },
    });

    if (existing) return { ok: true, contractId: existing.id, alreadyExists: true };

    const installments = body.installments ?? [];

    const c = await this.prisma.$transaction(async (tx) => {
      const contract = await tx.contract.create({
        data: {
          status: "DRAFT",
          presentationId: pres.id,
          customerId: pres.customerId,
          salespersonId: pres.salespersonId,
          unitType: pres.unitType!,
          weekOfYear: pres.weekOfYear!,
          paymentPlan: pres.paymentPlan!,
          basePriceCents: pres.basePriceCents!,
          nationality: body.nationality ?? null,
          passportNumber: body.passportNumber ?? null,
          email: body.email ?? null,
          address: body.address ?? null,
        },
        select: { id: true },
      });

      if (installments.length > 0) {
        await tx.customPaymentPlan.create({
          data: {
            contractId: contract.id,
            baseTotalCents: pres.basePriceCents!,
            installments: {
              create: installments.map((inst) => ({
                dueDate: new Date(inst.dueDate),
                baseAmountCents: inst.baseAmountCents,
                label: inst.label,
              })),
            },
          },
        });
      }

      return contract;
    });

    return { ok: true, contractId: c.id };
  }

  /**
   * 2) OTP2 gönder (DEV: otp döner)
   * POST /contracts/:id/send-otp
   */
  @Post(":id/send-otp")
  async sendOtp(@Param("id") id: string, @Req() req: Request & { user: AuthedUser }) {
    const me = req.user;

    const c = await this.prisma.contract.findUnique({
      where: { id },
      select: { id: true, salespersonId: true, status: true },
    });

    if (!c || c.salespersonId !== me.id) return { ok: false, message: "Sözleşme bulunamadı" };

    if (c.status !== "DRAFT" && c.status !== "CUSTOMER_CONFIRM_PENDING") {
      return { ok: false, message: "Bu sözleşme OTP gönderimine uygun değil" };
    }

    const otp = generateOtp();

    await this.prisma.contract.update({
      where: { id },
      data: {
        status: "CUSTOMER_CONFIRM_PENDING",
        customerOtpHash: hashOtp(otp),
        customerOtpSentAt: new Date(),
      },
    });

    return { ok: true, devOtp: otp };
  }

  /**
   * 3) OTP2 doğrula -> CUSTOMER_CONFIRMED
   * POST /contracts/:id/verify-otp
   */
  @Post(":id/verify-otp")
  async verifyOtp(
    @Param("id") id: string,
    @Body() body: VerifyOtpDto,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const me = req.user;

    const c = await this.prisma.contract.findUnique({
      where: { id },
      select: { id: true, salespersonId: true, status: true, customerOtpHash: true },
    });

    if (!c || c.salespersonId !== me.id) return { ok: false, message: "Sözleşme bulunamadı" };
    if (c.status !== "CUSTOMER_CONFIRM_PENDING") return { ok: false, message: "OTP doğrulama aşamasında değil" };
    if (!c.customerOtpHash || hashOtp(body.otp) !== c.customerOtpHash) return { ok: false, message: "OTP hatalı" };

    await this.prisma.contract.update({
      where: { id },
      data: {
        status: "CUSTOMER_CONFIRMED",
        customerConfirmedAt: new Date(),
      },
    });

    return { ok: true };
  }

  /**
   * 4) AUTHORITY Inbox (CUSTOMER_CONFIRMED)
   * GET /contracts/authority/inbox
   */
  @Get("authority/inbox")
  async authorityInbox(@Req() req: Request & { user: AuthedUser }) {
    const me = req.user;

    if (me.role !== "AUTHORITY" && me.role !== "ADMIN") {
      return { ok: false, message: "Yetkisiz (AUTHORITY gerekli)" };
    }

    const items = await this.prisma.contract.findMany({
      where: { status: "CUSTOMER_CONFIRMED" },
      orderBy: { createdAt: "desc" },
      include: {
        customer: { select: { fullName: true, phoneE164: true } },
        salesperson: { select: { id: true, fullName: true, phoneE164: true, level: true } },
      },
    });

    return { ok: true, items };
  }

  /**
   * 5) AUTHORITY Approve -> APPROVED + approvedById set
   * POST /contracts/:id/authority-approve
   * ✅ NOW triggers commissions automatically
   */
  @Post(":id/authority-approve")
  async authorityApprove(@Param("id") id: string, @Req() req: Request & { user: AuthedUser }) {
    const me = req.user;

    if (me.role !== "AUTHORITY" && me.role !== "ADMIN") {
      return { ok: false, message: "Yetkisiz (AUTHORITY gerekli)" };
    }

    const c = await this.prisma.contract.findUnique({
      where: { id },
      select: { status: true },
    });

    if (!c) return { ok: false, message: "Sözleşme yok" };
    if (c.status !== "CUSTOMER_CONFIRMED") return { ok: false, message: "Onaya uygun değil" };

    await this.prisma.contract.update({
      where: { id },
      data: {
        status: "APPROVED",
        approvedById: me.id,
      },
    });

    // ✅ Create commissions (idempotent)
    await this.commissions.calculateForApprovedContract(id);

    return { ok: true };
  }

  /**
   * 6) AUTHORITY Reject -> REJECTED
   * POST /contracts/:id/authority-reject
   */
  @Post(":id/authority-reject")
  async authorityReject(
    @Param("id") id: string,
    @Body() body: RejectDto,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const me = req.user;

    if (me.role !== "AUTHORITY" && me.role !== "ADMIN") {
      return { ok: false, message: "Yetkisiz (AUTHORITY gerekli)" };
    }

    const reason = body.reason?.trim();
    if (!reason) return { ok: false, message: "Reddetme sebebi gerekli" };

    const c = await this.prisma.contract.findUnique({ where: { id }, select: { status: true } });
    if (!c) return { ok: false, message: "Sözleşme yok" };
    if (c.status !== "CUSTOMER_CONFIRMED") return { ok: false, message: "Reddetmeye uygun değil" };

    await this.prisma.contract.update({
      where: { id },
      data: {
        status: "REJECTED",
        approvedById: me.id,
        rejectedReason: reason,
      },
    });

    return { ok: true };
  }

  /**
   * 7) Contract detail
   * GET /contracts/:id
   */
  @Get(":id")
  async getOne(@Param("id") id: string, @Req() req: Request & { user: AuthedUser }) {
    const me = req.user;

    const c = await this.prisma.contract.findUnique({
      where: { id },
      include: {
        customer: { select: { fullName: true, phoneE164: true } },
        salesperson: { select: { id: true, fullName: true, phoneE164: true, level: true } },
        approvedBy: { select: { id: true, fullName: true, phoneE164: true, role: true } },
        customPaymentPlan: {
          select: {
            baseTotalCents: true,
            installments: {
              select: { label: true, dueDate: true, baseAmountCents: true, isPaid: true },
              orderBy: { dueDate: "asc" },
            },
          },
        },
      },
    });

    if (!c) return { ok: false, message: "Sözleşme bulunamadı" };

    if (me.role === "ADMIN" || me.role === "AUTHORITY") return { ok: true, contract: c };
    if (c.salespersonId === me.id) return { ok: true, contract: c };

    if (me.role === "REGIONAL_MANAGER") {
      const subtree = await this.team.getSubtreeIds(me.id);
      if (subtree.has(c.salespersonId)) return { ok: true, contract: c };
    }

    return { ok: false, message: "Yetkisiz" };
  }

  /**
   * 8) Belge oluşturma için meta veri
   * GET /contracts/:id/doc-meta
   */
  @Get(":id/doc-meta")
  async getDocMeta(@Param("id") id: string, @Req() req: Request & { user: AuthedUser }) {
    const me = req.user;

    const c = await this.prisma.contract.findUnique({
      where: { id },
      include: {
        salesperson: { select: { id: true, fullName: true, leaderId: true } },
      },
    });

    if (!c) return { ok: false, message: "Sözleşme bulunamadı" };

    const canAccess =
      c.salespersonId === me.id ||
      me.role === "ADMIN" ||
      me.role === "AUTHORITY" ||
      (me.role === "REGIONAL_MANAGER" && (await this.team.getSubtreeIds(me.id)).has(c.salespersonId));

    if (!canAccess) return { ok: false, message: "Yetkisiz" };

    // WeekPrice'tan periodText al
    const weekPrice = await this.prisma.weekPrice.findUnique({
      where: { unitType_weekOfYear: { unitType: c.unitType, weekOfYear: c.weekOfYear } },
      select: { periodText: true },
    });

    // Hiyerarşide REGIONAL_MANAGER'ı bul
    let regionalManager: { fullName: string; phoneE164: string } | null = null;
    let currentLeaderId = c.salesperson.leaderId;
    while (currentLeaderId) {
      const leader = await this.prisma.user.findUnique({
        where: { id: currentLeaderId },
        select: { id: true, fullName: true, phoneE164: true, role: true, leaderId: true },
      });
      if (!leader) break;
      if (leader.role === "REGIONAL_MANAGER") {
        regionalManager = { fullName: leader.fullName, phoneE164: leader.phoneE164 };
        break;
      }
      currentLeaderId = leader.leaderId;
    }

    return {
      ok: true,
      periodText: weekPrice?.periodText ?? `${c.weekOfYear}. Hafta`,
      regionalManager,
    };
  }

  /**
   * 9) DOCX'i Supabase Storage'a yükle ve müşteriye WhatsApp ile gönder
   * POST /contracts/:id/send-doc-whatsapp
   */
  @Post(":id/send-doc-whatsapp")
  @UseInterceptors(FileInterceptor("file"))
  async sendDocWhatsApp(
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const me = req.user;

    if (!file) return { ok: false, message: "Dosya bulunamadı" };

    const c = await this.prisma.contract.findUnique({
      where: { id },
      select: {
        id: true,
        salespersonId: true,
        basePriceCents: true,
        paymentPlan: true,
        unitType: true,
        weekOfYear: true,
        customer: { select: { phoneE164: true, fullName: true } },
        customPaymentPlan: {
          select: {
            installments: {
              select: { dueDate: true, baseAmountCents: true, label: true },
              orderBy: { dueDate: "asc" },
            },
          },
        },
      },
    });

    if (!c || c.salespersonId !== me.id) {
      return { ok: false, message: "Sözleşme bulunamadı" };
    }

    const weekPrice = c.unitType && c.weekOfYear
      ? await this.prisma.weekPrice.findUnique({
          where: { unitType_weekOfYear: { unitType: c.unitType, weekOfYear: c.weekOfYear } },
          select: { periodText: true },
        })
      : null;

    const supabaseUrl = this.config.get<string>("SUPABASE_URL") ?? "";

    const safeName = c.customer.fullName.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ]/g, "_");
    const filePath = `${id}/rezervasyon_${safeName}.docx`;
    const { error: uploadError } = await this.supabase.storage
      .from("contracts")
      .upload(filePath, file.buffer, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        upsert: true,
      });

    if (uploadError) {
      return { ok: false, message: `Dosya yüklenemedi: ${uploadError.message}` };
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/contracts/${filePath}`;

    const periodText = weekPrice?.periodText ?? (c.weekOfYear ? `${c.weekOfYear}. Hafta` : "-");
    const totalEur = c.basePriceCents ? (c.basePriceCents / 100).toLocaleString("tr-TR", { minimumFractionDigits: 0 }) : "-";
    const planLabel = (c.paymentPlan && PLAN_LABELS[c.paymentPlan]) ?? "-";

    const installmentLines = c.customPaymentPlan?.installments.map((inst) => {
      const date = new Date(inst.dueDate).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" });
      const amount = (inst.baseAmountCents / 100).toLocaleString("tr-TR", { minimumFractionDigits: 0 });
      const label = inst.label ? `${inst.label} - ` : "";
      return `  • ${label}${date}: €${amount}`;
    }) ?? [];

    const message = [
      `Merhaba ${c.customer.fullName}, rezervasyon belgeniz hazır. Lütfen inceleyiniz.`,
      ``,
      `📋 *Rezervasyon Detayları*`,
      `• Dönem: ${periodText}`,
      `• Ödeme Planı: ${planLabel}`,
      `• Toplam Tutar: €${totalEur}`,
      ...(installmentLines.length > 0 ? [``, `💳 *Ödeme Takvimi*`, ...installmentLines] : []),
      ``,
      `🏦 *Banka Hesap Bilgileri*`,
      `Hesap Adı: CY-DND MAINTENANCE & SERVICE'S LTD.`,
      `SWIFT/BIC: TCZBTR2AXXX`,
      `TL Hesabı (IBAN): TR63 0001 0008 6198 3192 0850 01`,
      `EUR Hesabı (IBAN): TR09 0001 0008 6198 3192 0850 03`,
    ].join("\n");

    await this.sms.sendWhatsApp(c.customer.phoneE164, message, publicUrl);

    return { ok: true, docUrl: publicUrl, fileName: `rezervasyon_${safeName}.docx` };
  }

}