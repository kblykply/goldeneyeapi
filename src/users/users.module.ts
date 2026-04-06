import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { TeamModule } from "../team/team.module";
import { SmsModule } from "../sms/sms.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { UsersController } from "./users.controller";

@Module({
  imports: [PrismaModule, TeamModule, SmsModule, NotificationsModule],
  controllers: [UsersController],
})
export class UsersModule {}
