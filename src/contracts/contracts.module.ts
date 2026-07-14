import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ContractsController } from "./contracts.controller";
import { CommissionsModule } from "../commissions/commissions.module";
import { TeamModule } from "../team/team.module";
import { SmsModule } from "../sms/sms.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PricingModule } from "../pricing/pricing.module";

@Module({
  imports: [PrismaModule, CommissionsModule, TeamModule, SmsModule, NotificationsModule, PricingModule],
  controllers: [ContractsController],
})
export class ContractsModule {}