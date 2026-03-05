import { Module } from "@nestjs/common";
import { OtpService } from "./otp.service";
import { PrismaModule } from "../prisma/prisma.module";
import { SmsModule } from "../sms/sms.module";

@Module({
  imports: [PrismaModule, SmsModule],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}