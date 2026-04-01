import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogInput } from './audit.types';
import { RequestContextService } from './request-context.service';

type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ctxService: RequestContextService,
  ) {}

  async log(data: AuditLogInput): Promise<void> {
    const ctx = this.ctxService.get();
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: ctx?.actorId ?? null,
          ipAddress: ctx?.ipAddress ?? null,
          userAgent: ctx?.userAgent ?? null,
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId,
          presentationId: data.presentationId ?? null,
          contractId: data.contractId ?? null,
          meta: (data.meta as Prisma.InputJsonValue) ?? undefined,
        },
      });
    } catch (err) {
      // Audit hatası business operasyonunu asla patlatmaz
      this.logger.error('Audit log write failed', err);
    }
  }

  async logWithTx(tx: TxClient, data: AuditLogInput): Promise<void> {
    // Transaction içinde — hata transaction'ı rollback eder (intentional)
    const ctx = this.ctxService.get();
    await (tx as any).auditLog.create({
      data: {
        actorId: ctx?.actorId ?? null,
        ipAddress: ctx?.ipAddress ?? null,
        userAgent: ctx?.userAgent ?? null,
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId,
        presentationId: data.presentationId ?? null,
        contractId: data.contractId ?? null,
        meta: (data.meta as Prisma.InputJsonValue) ?? undefined,
      },
    });
  }
}
