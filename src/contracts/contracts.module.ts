import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ContractsController } from "./contracts.controller";
import { CommissionsModule } from "../commissions/commissions.module";
import { TeamModule } from "../team/team.module";
import { SmsModule } from "../sms/sms.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [PrismaModule, CommissionsModule, TeamModule, SmsModule, NotificationsModule],
  controllers: [ContractsController],
})
export class ContractsModule {}