import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OtpModule } from "../otp/otp.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { TeamModule } from "../team/team.module";
import { CustomerPortalController } from "./customer-portal.controller";

@Module({
  imports: [PrismaModule, OtpModule, NotificationsModule, TeamModule],
  controllers: [CustomerPortalController],
})
export class CustomerPortalModule {}
