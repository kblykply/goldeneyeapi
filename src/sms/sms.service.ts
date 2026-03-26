import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Twilio from "twilio";

@Injectable()
export class SmsService {
  private client: Twilio.Twilio;
  private verifySid: string;
  private whatsappFrom: string;
  private contentSid: string;
  private welcomeContentSid: string;
  private appUrl: string;

  constructor(private config: ConfigService) {
    const sid = this.config.get<string>("TWILIO_ACCOUNT_SID") ?? "";
    const token = this.config.get<string>("TWILIO_AUTH_TOKEN") ?? "";
    this.verifySid = this.config.get<string>("TWILIO_VERIFY_SID") ?? "";
    this.whatsappFrom = this.config.get<string>("TWILIO_WHATSAPP_FROM") ?? "";
    this.contentSid = this.config.get<string>("TWILIO_CONTENT_SID") ?? "";
    this.welcomeContentSid = this.config.get<string>("TWILIO_WELCOME_CONTENT_SID") ?? "";
    this.appUrl = this.config.get<string>("APP_URL") ?? "";

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

  async sendWhatsApp(toE164: string, variables: Record<string, string>, contentSid = this.contentSid) {
    const msg = await this.client.messages.create({
      from: this.whatsappFrom,
      to: `whatsapp:${toE164}`,
      contentSid,
      contentVariables: JSON.stringify(variables),
    });
    return { sid: msg.sid, status: msg.status };
  }

  async sendWelcomeWhatsApp(toE164: string, fullName: string) {
    return this.sendWhatsApp(toE164, { "1": fullName, "2": this.appUrl }, this.welcomeContentSid);
  }
}
