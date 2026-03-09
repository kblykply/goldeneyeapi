import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OtpModule } from "../otp/otp.module";
import { PresentationsController } from "./presentations.controller";

@Module({
  imports: [PrismaModule, OtpModule],
  controllers: [PresentationsController],
})
export class PresentationsModule {}