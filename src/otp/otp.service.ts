import { Injectable } from "@nestjs/common";
import { SmsService } from "../sms/sms.service";

type Purpose = "LOGIN" | "PRESENTATION_OPEN" | "CONTRACT_CONFIRM" | "CUSTOMER_PORTAL";

@Injectable()
export class OtpService {
  constructor(private sms: SmsService) {}

  async requestOtp(params: {
    phoneE164: string;
    purpose: Purpose;
    message?: (otp: string) => string;
    meta?: any;
  }) {
    await this.sms.sendVerification(params.phoneE164);
    return { ok: true };
  }

  async verifyOtp(params: { phoneE164: string; purpose: Purpose; otp: string }) {
    const result = await this.sms.checkVerification(params.phoneE164, params.otp);
    if (!result.valid) return { ok: false, message: "Kod hatalı veya süresi doldu." };
    return { ok: true };
  }
}
