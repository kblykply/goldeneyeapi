import { Module } from '@nestjs/common';
import { ZiraatMpiService } from './ziraat-mpi.service';
import { ZiraatVposService } from './ziraat-vpos.service';

@Module({
  providers: [ZiraatMpiService, ZiraatVposService],
  exports: [ZiraatMpiService, ZiraatVposService],
})
export class PaymentModule {}
