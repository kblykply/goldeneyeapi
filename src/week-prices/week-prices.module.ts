import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { WeekPricesService } from "./week-prices.service";
import { WeekPricesController } from "./week-prices.controller";

@Module({
  imports: [PrismaModule],
  controllers: [WeekPricesController],
  providers: [WeekPricesService],
})
export class WeekPricesModule {}
