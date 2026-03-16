import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Twilio from "twilio";

@Injectable()
export class SmsService {
  private client: Twilio.Twilio;
  private verifySid: string;
  private whatsappFrom: string;

  constructor(private config: ConfigService) {
    const sid = this.config.get<string>("TWILIO_ACCOUNT_SID") ?? "";
    const token = this.config.get<string>("TWILIO_AUTH_TOKEN") ?? "";
    this.verifySid = this.config.get<string>("TWILIO_VERIFY_SID") ?? "";
    this.whatsappFrom = this.config.get<string>("TWILIO_WHATSAPP_FROM") ?? "whatsapp:+14155238886";

    this.client = Twilio(sid || "", token || "");
  }

  async sendVerification(toE164: string) {
    const v = await this.client.verify.v2
      .services(this.verifySid)
      .verifications.create({ to: toE164, channel: "sms" });
    return { sid: v.sid, status: v.status };
  }

  async checkVerification(toE164: string, code: string) {
    const check = await this.client.verify.v2
      .services(this.verifySid)
      .verificationChecks.create({ to: toE164, code });
    return { valid: check.status === "approved" };
  }

  async sendWhatsApp(toE164: string, body: string, mediaUrl?: string) {
    const msg = await this.client.messages.create({
      from: this.whatsappFrom,
      to: `whatsapp:${toE164}`,
      body,
      ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {}),
    });
    return { sid: msg.sid, status: msg.status };
  }
}
