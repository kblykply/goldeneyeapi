import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ContractsController } from "./contracts.controller";
import { CommissionsModule } from "../commissions/commissions.module";
import { TeamModule } from "../team/team.module";

@Module({
  imports: [PrismaModule, CommissionsModule, TeamModule],
  controllers: [ContractsController],
})
export class ContractsModule {}