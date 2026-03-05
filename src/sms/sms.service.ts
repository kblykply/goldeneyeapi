import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Twilio from "twilio";

@Injectable()
export class SmsService {
  private client: Twilio.Twilio;
  private from: string;

  constructor(private config: ConfigService) {
    const sid = this.config.get<string>("TWILIO_ACCOUNT_SID") ?? "";
    const token = this.config.get<string>("TWILIO_AUTH_TOKEN") ?? "";
    this.from = this.config.get<string>("TWILIO_FROM") ?? "";

    if (!sid || !token) {
      // still allow boot for dev; but sending will fail if missing
      this.client = Twilio("", "");
      return;
    }

    this.client = Twilio(sid, token);
  }

  async send(toE164: string, message: string) {
    if (!this.from) throw new Error("TWILIO_FROM is missing");
    const res = await this.client.messages.create({
      to: toE164,
      from: this.from,
      body: message,
    });
    return { sid: res.sid, status: res.status };
  }
}