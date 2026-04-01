import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditService } from './audit.service';
import { RequestContextInterceptor } from './request-context.interceptor';
import { RequestContextService } from './request-context.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    RequestContextService,
    AuditService,
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
  exports: [AuditService, RequestContextService],
})
export class AuditModule {}
