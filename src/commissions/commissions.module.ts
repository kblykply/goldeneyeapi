import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { TeamModule } from "../team/team.module";
import { CommissionService } from "./commission.service";
import { CommissionsController } from "./commissions.controller";

@Module({
  imports: [PrismaModule, TeamModule],
  providers: [CommissionService],
  controllers: [CommissionsController],
  exports: [CommissionService],
})
export class CommissionsModule {}