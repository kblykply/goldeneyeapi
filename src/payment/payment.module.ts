import { Module } from '@nestjs/common';
import { ZiraatMpiService } from './ziraat-mpi.service';
import { ZiraatVposService } from './ziraat-vpos.service';
import { ExchangeRateService } from './exchange-rate.service';

@Module({
  providers: [ZiraatMpiService, ZiraatVposService, ExchangeRateService],
  exports: [ZiraatMpiService, ZiraatVposService, ExchangeRateService],
})
export class PaymentModule {}
