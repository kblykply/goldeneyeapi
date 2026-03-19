import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { TeamModule } from "../team/team.module";
import { UsersController } from "./users.controller";

@Module({
  imports: [PrismaModule, TeamModule],
  controllers: [UsersController],
})
export class UsersModule {}
