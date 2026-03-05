import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { SmsService } from "../sms/sms.service";
import * as crypto from "crypto";

function hashOtp(otp: string) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

type Purpose = "LOGIN" | "PRESENTATION_OPEN" | "CONTRACT_CONFIRM";

@Injectable()
export class OtpService {
  private ttlSec: number;
  private maxAttempts: number;
  private cooldownSec: number;

  constructor(
    private prisma: PrismaService,
    private sms: SmsService,
    private config: ConfigService
  ) {
    this.ttlSec = Number(this.config.get("OTP_TTL_SEC") ?? 300);
    this.maxAttempts = Number(this.config.get("OTP_MAX_ATTEMPTS") ?? 5);
    this.cooldownSec = Number(this.config.get("OTP_RESEND_COOLDOWN_SEC") ?? 60);
  }

  async requestOtp(params: {
    phoneE164: string;
    purpose: Purpose;
    message: (otp: string) => string;
    meta?: any;
  }) {
    const now = new Date();

    // cooldown check (unconsumed active OTP)
    const recent = await this.prisma.otpCode.findFirst({
      where: {
        phoneE164: params.phoneE164,
        purpose: params.purpose as any,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    if (recent) {
      const ageSec = Math.floor((now.getTime() - recent.createdAt.getTime()) / 1000);
      if (ageSec < this.cooldownSec) {
        return { ok: false, message: `Lütfen ${this.cooldownSec - ageSec} sn sonra tekrar deneyin.` };
      }
    }

    const otp = generateOtp();
    const expiresAt = new Date(now.getTime() + this.ttlSec * 1000);

    await this.prisma.otpCode.create({
      data: {
        phoneE164: params.phoneE164,
        purpose: params.purpose as any,
        otpHash: hashOtp(otp),
        expiresAt,
        meta: params.meta ?? undefined,
      },
    });

    await this.sms.send(params.phoneE164, params.message(otp));

    // Dev convenience: return OTP only if not production
    const devOtp = process.env.NODE_ENV === "production" ? undefined : otp;

    return { ok: true, devOtp };
  }

  async verifyOtp(params: { phoneE164: string; purpose: Purpose; otp: string }) {
    const now = new Date();

    const rec = await this.prisma.otpCode.findFirst({
      where: {
        phoneE164: params.phoneE164,
        purpose: params.purpose as any,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!rec) return { ok: false, message: "Kod bulunamadı veya süresi doldu." };
    if (rec.attempts >= this.maxAttempts) {
      return { ok: false, message: "Çok fazla deneme. Yeni kod isteyin." };
    }

    const valid = hashOtp(params.otp) === rec.otpHash;

    await this.prisma.otpCode.update({
      where: { id: rec.id },
      data: {
        attempts: { increment: 1 },
        consumedAt: valid ? now : undefined,
      },
    });

    if (!valid) return { ok: false, message: "Kod hatalı." };
    return { ok: true };
  }
}