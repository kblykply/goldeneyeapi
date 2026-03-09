import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OtpModule } from "../otp/otp.module";
import { CurrencyModule } from "../currency/currency.module";
import { PresentationsController } from "./presentations.controller";

@Module({
  imports: [PrismaModule, OtpModule, CurrencyModule],
  controllers: [PresentationsController],
})
export class PresentationsModule {}