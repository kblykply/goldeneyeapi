import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { TeamModule } from "../team/team.module";
import { SmsModule } from "../sms/sms.module";
import { UsersController } from "./users.controller";

@Module({
  imports: [PrismaModule, TeamModule, SmsModule],
  controllers: [UsersController],
})
export class UsersModule {}
