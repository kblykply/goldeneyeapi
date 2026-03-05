import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthGuard } from "../auth/auth.guard";
import { AuthedUser } from "../auth/auth.types";
import { Request } from "express";
import { IsString } from "class-validator";
import * as crypto from "crypto";
import { CommissionService } from "../commissions/commission.service";

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

@Controller("contracts")
@UseGuards(AuthGuard)
export class ContractsController {
  constructor(
    private prisma: PrismaService,
    private commissions: CommissionService // ✅ inject
  ) {}

  /**
   * 1) Presentation'dan Contract oluştur (DRAFT)
   * POST /contracts/from-presentation/:presentationId
   */
  @Post("from-presentation/:presentationId")
  async createFromPresentation(
    @Param("presentationId") presentationId: string,
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

    if (!pres.unitType || !pres.weekOfYear || !pres.paymentPlan || !pres.priceCents) {
      return { ok: false, message: "Sunum tamamlanmamış (unit/hafta/plan/fiyat eksik)" };
    }

    const existing = await this.prisma.contract.findFirst({
      where: { presentationId: pres.id },
      select: { id: true },
    });

    if (existing) return { ok: true, contractId: existing.id, alreadyExists: true };

    const c = await this.prisma.contract.create({
      data: {
        status: "DRAFT",
        presentationId: pres.id,
        customerId: pres.customerId,
        salespersonId: pres.salespersonId,
        unitType: pres.unitType,
        weekOfYear: pres.weekOfYear,
        paymentPlan: pres.paymentPlan,
        priceCents: pres.priceCents,
      },
      select: { id: true },
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
      },
    });

    if (!c) return { ok: false, message: "Sözleşme bulunamadı" };

    if (me.role === "ADMIN" || me.role === "AUTHORITY") return { ok: true, contract: c };
    if (c.salespersonId === me.id) return { ok: true, contract: c };

    return { ok: false, message: "Yetkisiz" };
  }
}