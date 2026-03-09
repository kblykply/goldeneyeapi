import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { PrismaModule } from "../prisma/prisma.module";
import { CurrencyService } from "./currency.service";
import { CurrencyController } from "./currency.controller";

@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule],
  controllers: [CurrencyController],
  providers: [CurrencyService],
  exports: [CurrencyService],
})
export class CurrencyModule {}
