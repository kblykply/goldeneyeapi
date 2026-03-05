import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ContractsController } from "./contracts.controller";
import { CommissionsModule } from "../commissions/commissions.module";

@Module({
  imports: [PrismaModule, CommissionsModule], // ✅ add CommissionsModule
  controllers: [ContractsController],
})
export class ContractsModule {}