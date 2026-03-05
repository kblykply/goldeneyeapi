import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthGuard } from "../auth/auth.guard";
import { AuthedUser } from "../auth/auth.types";
import { Request } from "express";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from "class-validator";
import * as crypto from "crypto";

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

function hashOtp(otp: string) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
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
  constructor(private prisma: PrismaService) {}

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

    const otp = generateOtp();

    const pres = await this.prisma.presentation.create({
      data: {
        status: "OTP_SENT",
        salespersonId: me.id,
        customerId: customer.id,
        otpHash: hashOtp(otp),
        otpSentAt: new Date(),
        ipAddress: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
      },
      select: { id: true, status: true },
    });

    return {
      presentationId: pres.id,
      status: pres.status,
      devOtp: otp,
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
      select: { id: true, otpHash: true, salespersonId: true },
    });

    if (!pres || pres.salespersonId !== me.id) {
      return { ok: false, message: "Sunum bulunamadı" };
    }

    if (!pres.otpHash || hashOtp(body.otp) !== pres.otpHash) {
      return { ok: false, message: "OTP hatalı" };
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
    @Req() req: Request & { user: AuthedUser }
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

    // ✅ optional: also fetch periodText for UI
    let periodText: string | null = null;
    if (pres.unitType && pres.weekOfYear) {
      const row = await this.prisma.weekPrice.findUnique({
        where: { unitType_weekOfYear: { unitType: pres.unitType as any, weekOfYear: pres.weekOfYear } },
        select: { periodText: true },
      });
      periodText = row?.periodText ?? null;
    }

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
        priceCents: pres.priceCents,
        periodText, // ✅
        customer: pres.customer,
      },
    };
  }

  @Patch(":id")
  async updateOne(
    @Param("id") id: string,
    @Body() body: UpdatePresentationDto,
    @Req() req: Request & { user: AuthedUser }
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
        // ✅ Always set when computable, else clear it
        priceCents: priceCents ?? null,
      },
      include: { customer: { select: { fullName: true, phoneE164: true } } },
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
        priceCents: updated.priceCents,
        periodText, // ✅ for UI
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