import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OtpModule } from "../otp/otp.module";
import { CurrencyModule } from "../currency/currency.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PresentationsController } from "./presentations.controller";

@Module({
  imports: [PrismaModule, OtpModule, CurrencyModule, NotificationsModule],
  controllers: [PresentationsController],
})
export class PresentationsModule {}