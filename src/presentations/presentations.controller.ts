import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OtpService } from "../otp/otp.service";
import { CurrencyService } from "../currency/currency.service";
import { AuthGuard } from "../auth/auth.guard";
import { AuthedUser } from "../auth/auth.types";
import { Request } from "express";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from "class-validator";

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

// ✅ price column mapping
function priceFromWeekPriceRow(
  row: { pesinCents: number; taksit6Cents: number; taksit12Cents: number },
  plan: "PESIN" | "ALTIN" | "TAKSIT_12"
) {
  if (plan === "PESIN") return row.pesinCents;
  if (plan === "ALTIN") return row.taksit6Cents; // UI: 6 Ay
  return row.taksit12Cents; // TAKSIT_12
}

@Controller("presentations")
@UseGuards(AuthGuard)
export class PresentationsController {
  constructor(
    private prisma: PrismaService,
    private otp: OtpService,
    private currency: CurrencyService,
  ) {}

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

    return { ok: true, status: updated.status, openedAt: updated.openedAt };
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

    if (!pres || pres.salespersonId !== me.id) {
      return { ok: false, message: "Sunum bulunamadı" };
    }

    const targetCurrency: SupportedCurrency =
      SUPPORTED_CURRENCIES.includes(currencyParam as SupportedCurrency)
        ? (currencyParam as SupportedCurrency)
        : "GBP";

    let periodText: string | null = null;
    if (pres.unitType && pres.weekOfYear) {
      const row = await this.prisma.weekPrice.findUnique({
        where: { unitType_weekOfYear: { unitType: pres.unitType as any, weekOfYear: pres.weekOfYear } },
        select: { periodText: true },
      });
      periodText = row?.periodText ?? null;
    }

    const price =
      pres.priceCents != null
        ? await this.currency.convertFromGbpPence(pres.priceCents, targetCurrency)
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

    if (!existing || existing.salespersonId !== me.id) {
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
        : "GBP";

    // ✅ price + periodText from DB
    let priceCents: number | null = null;
    let periodText: string | null = null;

    if (merged.unitType && merged.weekOfYear && merged.paymentPlan) {
      const row = await this.prisma.weekPrice.findUnique({
        where: { unitType_weekOfYear: { unitType: merged.unitType, weekOfYear: merged.weekOfYear } },
        select: { pesinCents: true, taksit6Cents: true, taksit12Cents: true, periodText: true },
      });

      if (!row) {
        return { ok: false, message: "Fiyat tablosunda bu ünite/hafta bulunamadı" };
      }

      priceCents = priceFromWeekPriceRow(row, merged.paymentPlan);
      periodText = row.periodText;
    }

    const updated = await this.prisma.presentation.update({
      where: { id },
      data: {
        step: body.step ?? undefined,
        videoCompleted: body.videoCompleted ?? undefined,
        unitType: body.unitType ?? undefined,
        weekOfYear: body.weekOfYear ?? undefined,
        paymentPlan: body.paymentPlan ?? undefined,
        priceCents: priceCents ?? null,
      },
      include: { customer: { select: { fullName: true, phoneE164: true } } },
    });

    const price =
      updated.priceCents != null
        ? await this.currency.convertFromGbpPence(updated.priceCents, targetCurrency)
        : null;

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
        price,
        currency: targetCurrency,
        periodText,
        customer: updated.customer,
      },
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

    return { ok: true, status: updated.status, durationSec: updated.durationSec };
  }
}