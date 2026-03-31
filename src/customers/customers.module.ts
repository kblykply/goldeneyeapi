import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { TeamModule } from "../team/team.module";
import { CustomersController } from "./customers.controller";

@Module({
  imports: [PrismaModule, TeamModule],
  controllers: [CustomersController],
})
export class CustomersModule {}
