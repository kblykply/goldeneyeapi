import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { ZiraatMpiService } from './ziraat-mpi.service';
import { ZiraatVposService } from './ziraat-vpos.service';
import { ExchangeRateService } from './exchange-rate.service';
import { BankMessageLogService } from './bank-message-log.service';

@Module({
  // ScheduleModule: banka mesaj log'larının saklama süresi temizliği için
  imports: [ScheduleModule.forRoot(), PrismaModule],
  providers: [ZiraatMpiService, ZiraatVposService, ExchangeRateService, BankMessageLogService],
  exports: [ZiraatMpiService, ZiraatVposService, ExchangeRateService, BankMessageLogService],
})
export class PaymentModule {}
