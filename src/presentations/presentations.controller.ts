import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OtpService } from "../otp/otp.service";
import { CurrencyService } from "../currency/currency.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuthedUser } from "../auth/auth.types";
import { Request } from "express";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from "class-validator";
import { AuditService } from "../audit/audit.service";
import { PricingService } from "../pricing/pricing.service";

const SUPPORTED_CURRENCIES = ["GBP", "EUR", "USD", "TRY"] as const;
type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
const SALES_SKIP_OTP_ALLOWED_USER_IDS = new Set(["cmmkch0iz0003ob2pmvz0qqd4"]);

class StartPresentationDto {
  @IsString()
  customerFullName!: string;

  @IsString()
  @Matches(/^\+\d{10,15}$/)
  customerPhoneE164!: string;
}

class VerifyOtpDto {
  @IsString()
  presentationId!: string;

  @IsString()
  otp!: string;
}

class EndPresentationDto {
  @IsString()
  presentationId!: string;
}

class UpdatePresentationDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  step?: number;

  @IsOptional()
  @IsBoolean()
  videoCompleted?: boolean;

  @IsOptional()
  @IsIn(["STUDIO", "ONE_PLUS_ONE", "TWO_PLUS_ONE"])
  unitType?: "STUDIO" | "ONE_PLUS_ONE" | "TWO_PLUS_ONE";

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(52)
  weekOfYear?: number;

  @IsOptional()
  @IsIn(["PESIN", "ALTIN", "TAKSIT_12"])
  paymentPlan?: "PESIN" | "ALTIN" | "TAKSIT_12";
}

@Controller("presentations")
export class PresentationsController {
  constructor(
    private prisma: PrismaService,
    private otp: OtpService,
    private currency: CurrencyService,
    private audit: AuditService,
    private notifs: NotificationsService,
    private pricing: PricingService,
  ) {}

  private notifyPresentation(
    type: "PRESENTATION_STARTED" | "PRESENTATION_ENDED",
    title: string,
    body: string,
    actorId: string,
    presentationId: string,
  ) {
    this.notifs.create({ type, title, body, actorId, entityId: presentationId, entityType: "PRESENTATION" }).catch(() => {});
  }

  @Post("start")
  async start(
    @Body() body: StartPresentationDto,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const me = req.user;

    const customer = await this.prisma.customer.upsert({
      where: { phoneE164: body.customerPhoneE164 },
      update: { fullName: body.customerFullName },
      create: { fullName: body.customerFullName, phoneE164: body.customerPhoneE164 },
    });

    const pres = await this.prisma.presentation.create({
      data: {
        status: "OTP_SENT",
        salespersonId: me.id,
        customerId: customer.id,
        otpSentAt: new Date(),
        ipAddress: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
      },
      select: { id: true, status: true },
    });

    const result = await this.otp.requestOtp({
      phoneE164: body.customerPhoneE164,
      purpose: "PRESENTATION_OPEN",
      message: (code) => `Sunum doğrulama kodunuz: ${code}`,
      meta: { presentationId: pres.id },
    });

    if (!result.ok) {
      return { ok: false, message: "OTP gönderilemedi." };
    }

    await this.audit.log({
      action: 'PRESENTATION_STARTED',
      entityType: 'PRESENTATION',
      entityId: pres.id,
      presentationId: pres.id,
      meta: { customerId: customer.id },
    });

    this.notifyPresentation('PRESENTATION_STARTED', 'Sunum Başlatıldı', `${me.fullName} yeni bir sunum başlattı`, me.id, pres.id);

    return {
      ok: true,
      presentationId: pres.id,
      status: pres.status,
      customer: { fullName: customer.fullName, phoneE164: customer.phoneE164 },
    };
  }

  @Post("admin/start-skip-otp")
  async adminStartSkipOtp(
    @Body() body: StartPresentationDto,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const me = req.user;

    const canSkipOtp = me.role === "ADMIN" || SALES_SKIP_OTP_ALLOWED_USER_IDS.has(me.id);
    if (!canSkipOtp) {
      return { ok: false, message: "Yetkisiz işlem" };
    }

    const customer = await this.prisma.customer.upsert({
      where: { phoneE164: body.customerPhoneE164 },
      update: { fullName: body.customerFullName },
      create: { fullName: body.customerFullName, phoneE164: body.customerPhoneE164 },
    });

    const pres = await this.prisma.presentation.create({
      data: {
        status: "OPENED",
        salespersonId: me.id,
        customerId: customer.id,
        openedAt: new Date(),
        step: 1,
        ipAddress: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
      },
      select: { id: true, status: true },
    });

    await this.audit.log({
      action: 'PRESENTATION_STARTED',
      entityType: 'PRESENTATION',
      entityId: pres.id,
      presentationId: pres.id,
      meta: { skipOtp: true, customerId: customer.id },
    });

    this.notifyPresentation('PRESENTATION_STARTED', 'Sunum Başlatıldı', `${me.fullName} yeni bir sunum başlattı`, me.id, pres.id);

    return {
      ok: true,
      presentationId: pres.id,
      status: pres.status,
      customer: { fullName: customer.fullName, phoneE164: customer.phoneE164 },
    };
  }

  @Post("verify-otp")
  async verify(
    @Body() body: VerifyOtpDto,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const me = req.user;

    const pres = await this.prisma.presentation.findUnique({
      where: { id: body.presentationId },
      select: { id: true, salespersonId: true, customer: { select: { phoneE164: true } } },
    });

    if (!pres || pres.salespersonId !== me.id) {
      return { ok: false, message: "Sunum bulunamadı" };
    }

    const result = await this.otp.verifyOtp({
      phoneE164: pres.customer.phoneE164,
      purpose: "PRESENTATION_OPEN",
      otp: body.otp,
    });

    if (!result.ok) {
      return { ok: false, message: result.message };
    }

    const updated = await this.prisma.presentation.update({
      where: { id: pres.id },
      data: {
        status: "OPENED",
        openedAt: new Date(),
        step: 1,
      },
      select: { id: true, status: true, openedAt: true },
    });

    await this.audit.log({
      action: 'PRESENTATION_OPENED',
      entityType: 'PRESENTATION',
      entityId: pres.id,
      presentationId: pres.id,
    });

    return { ok: true, status: updated.status, openedAt: updated.openedAt };
  }

  @Get("check-customer")
  async checkCustomer(@Query("phone") phone: string) {
    if (!phone) {
      return { hasRecentPresentation: false, lastPresentationDate: null };
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const customer = await this.prisma.customer.findUnique({
      where: { phoneE164: phone },
      select: {
        presentations: {
          where: { createdAt: { gte: thirtyDaysAgo } },
          take: 1,
          select: { id: true },
        },
      },
    });

    return { hasRecentPresentation: (customer?.presentations.length ?? 0) > 0 };
  }

  @Get(":id")
  async getOne(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthedUser },
    @Query("currency") currencyParam?: string,
  ) {
    const me = req.user;

    const pres = await this.prisma.presentation.findUnique({
      where: { id },
      include: {
        customer: { select: { fullName: true, phoneE164: true } },
      },
    });

    if (!pres || (pres.salespersonId !== me.id && me.role !== "ADMIN")) {
      return { ok: false, message: "Sunum bulunamadı" };
    }

    const targetCurrency: SupportedCurrency =
      SUPPORTED_CURRENCIES.includes(currencyParam as SupportedCurrency)
        ? (currencyParam as SupportedCurrency)
        : "EUR";

    const periodText = pres.weekOfYear
      ? await this.pricing.getPeriodText(pres.weekOfYear)
      : null;

    const price =
      pres.basePriceCents != null
        ? await this.currency.convertFromBaseCents(pres.basePriceCents, targetCurrency)
        : null;

    return {
      ok: true,
      presentation: {
        id: pres.id,
        status: pres.status,
        step: pres.step,
        videoCompleted: pres.videoCompleted,
        unitType: pres.unitType,
        weekOfYear: pres.weekOfYear,
        paymentPlan: pres.paymentPlan,
        basePriceCents: pres.basePriceCents,
        price,
        currency: targetCurrency,
        periodText,
        customer: pres.customer,
      },
    };
  }

  @Patch(":id")
  async updateOne(
    @Param("id") id: string,
    @Body() body: UpdatePresentationDto,
    @Req() req: Request & { user: AuthedUser },
    @Query("currency") currencyParam?: string,
  ) {
    const me = req.user;

    const existing = await this.prisma.presentation.findUnique({
      where: { id },
      select: {
        id: true,
        salespersonId: true,
        unitType: true,
        weekOfYear: true,
        paymentPlan: true,
      },
    });

    if (!existing || (existing.salespersonId !== me.id && me.role !== "ADMIN")) {
      return { ok: false, message: "Sunum bulunamadı" };
    }

    const merged = {
      unitType: (body.unitType ?? existing.unitType) as any as ("STUDIO" | "ONE_PLUS_ONE" | "TWO_PLUS_ONE" | null),
      weekOfYear: (body.weekOfYear ?? existing.weekOfYear) as number | null,
      paymentPlan: (body.paymentPlan ?? existing.paymentPlan) as any as ("PESIN" | "ALTIN" | "TAKSIT_12" | null),
    };

    const targetCurrency: SupportedCurrency =
      SUPPORTED_CURRENCIES.includes(currencyParam as SupportedCurrency)
        ? (currencyParam as SupportedCurrency)
        : "EUR";

    let basePriceCents: number | null = null;
    let periodText: string | null = null;

    if (merged.unitType && merged.weekOfYear && merged.paymentPlan) {
      const resolved = await this.pricing.resolve(merged.unitType, merged.weekOfYear, merged.paymentPlan);

      if (!resolved) {
        return { ok: false, message: "Fiyat tablosunda bu ünite/hafta bulunamadı" };
      }

      basePriceCents = resolved.basePriceCents;
      periodText = resolved.periodText;
    }

    const updated = await this.prisma.presentation.update({
      where: { id },
      data: {
        step: body.step ?? undefined,
        videoCompleted: body.videoCompleted ?? undefined,
        unitType: body.unitType ?? undefined,
        weekOfYear: body.weekOfYear ?? undefined,
        paymentPlan: body.paymentPlan ?? undefined,
        basePriceCents: basePriceCents ?? null,
      },
      include: { customer: { select: { fullName: true, phoneE164: true } } },
    });

    const price =
      updated.basePriceCents != null
        ? await this.currency.convertFromBaseCents(updated.basePriceCents, targetCurrency)
        : null;

    await this.audit.log({
      action: 'PRESENTATION_UPDATED',
      entityType: 'PRESENTATION',
      entityId: id,
      presentationId: id,
      meta: { fields: Object.keys(body).filter((k) => (body as any)[k] !== undefined) },
    });

    return {
      ok: true,
      presentation: {
        id: updated.id,
        status: updated.status,
        step: updated.step,
        videoCompleted: updated.videoCompleted,
        unitType: updated.unitType,
        weekOfYear: updated.weekOfYear,
        paymentPlan: updated.paymentPlan,
        basePriceCents: updated.basePriceCents,
        price,
        currency: targetCurrency,
        periodText,
        customer: updated.customer,
      },
    };
  }

  
  @Get(":id/doc-meta")
  async getDocMeta(@Param("id") id: string, @Req() req: Request & { user: AuthedUser }) {
    const me = req.user;

    const pres = await this.prisma.presentation.findUnique({
      where: { id },
      include: { salesperson: { select: { id: true, leaderId: true } } },
    });

    if (!pres || (pres.salespersonId !== me.id && me.role !== "ADMIN")) {
      return { ok: false, message: "Sunum bulunamadı" };
    }

    if (!pres.unitType || !pres.weekOfYear) {
      return { ok: false, message: "Sunum tamamlanmamış" };
    }

    const periodText = await this.pricing.getPeriodText(pres.weekOfYear);

    let regionalManager: { fullName: string; phoneE164: string } | null = null;
    let currentLeaderId = pres.salesperson.leaderId;
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
      periodText: periodText ?? `${pres.weekOfYear}. Hafta`,
      regionalManager,
    };
  }

  @Post("end")
  async end(
    @Body() body: EndPresentationDto,
    @Req() req: Request & { user: AuthedUser }
  ) {
    const me = req.user;

    const pres = await this.prisma.presentation.findUnique({
      where: { id: body.presentationId },
      select: { id: true, salespersonId: true, openedAt: true, createdAt: true },
    });

    if (!pres || pres.salespersonId !== me.id) {
      return { ok: false, message: "Sunum bulunamadı" };
    }

    const endedAt = new Date();
    const start = pres.openedAt ?? pres.createdAt;
    const durationSec = Math.max(0, Math.floor((endedAt.getTime() - start.getTime()) / 1000));

    const updated = await this.prisma.presentation.update({
      where: { id: pres.id },
      data: { status: "ENDED", endedAt, durationSec },
      select: { id: true, status: true, durationSec: true },
    });

    await this.audit.log({
      action: 'PRESENTATION_ENDED',
      entityType: 'PRESENTATION',
      entityId: pres.id,
      presentationId: pres.id,
      meta: { durationSec: updated.durationSec },
    });

    this.notifyPresentation('PRESENTATION_ENDED', 'Sunum Tamamlandı', `${me.fullName} sunumunu tamamladı`, me.id, pres.id);

    return { ok: true, status: updated.status, durationSec: updated.durationSec };
  }
}