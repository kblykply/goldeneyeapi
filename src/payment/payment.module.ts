import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { ExchangeRateService } from './exchange-rate.service';
import { BankMessageLogService } from './bank-message-log.service';
import { PosTransactionCleanupService } from './pos-transaction-cleanup.service';

@Module({
  // ScheduleModule: banka mesaj log'larının saklama süresi ve yarıda kalan ödemelerin temizliği için
  imports: [ScheduleModule.forRoot(), PrismaModule],
  providers: [
    ExchangeRateService,
    BankMessageLogService,
    PosTransactionCleanupService,
  ],
  exports: [ExchangeRateService, BankMessageLogService],
})
export class PaymentModule {}
