import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OtpModule } from "../otp/otp.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { TeamModule } from "../team/team.module";
import { AuditModule } from "../audit/audit.module";
import { PaymentModule } from "../payment/payment.module";
import { CommissionsModule } from "../commissions/commissions.module";
import { CustomerPortalController } from "./customer-portal.controller";

@Module({
  imports: [
    PrismaModule,
    OtpModule,
    NotificationsModule,
    TeamModule,
    AuditModule,
    PaymentModule,
    CommissionsModule,
  ],
  controllers: [CustomerPortalController],
})
export class CustomerPortalModule {}
