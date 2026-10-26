import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

// 3D oturumu bankada birkaç dakikada zaman aşımına düşer; bu süreden eski bir
// PENDING işlem için callback gelmez. Pay bırakılarak 30 dk seçildi.
const ABANDONED_AFTER_MS = 30 * 60 * 1000;

/**
 * Yarıda kalan (3D sayfasında bırakılmış) ödemeleri kapatır.
 *
 * Callback hiç gelmezse işlem PENDING kalır ve şifreli kart token'ı (Pan/Expiry)
 * süresiz saklanırdı (PCI DSS 3.3.1, 3.3.2). Burada FAILED'a çekilir ve token silinir.
 * Bankaya hiçbir istek gitmez; çekim yalnızca callback'teki VPos çağrısıyla olur.
 */
@Injectable()
export class PosTransactionCleanupService {
  private readonly logger = new Logger(PosTransactionCleanupService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async expireAbandoned(): Promise<void> {
    const cutoff = new Date(Date.now() - ABANDONED_AFTER_MS);
    try {
      const stale = await this.prisma.posTransaction.findMany({
        where: { status: 'PENDING', createdAt: { lt: cutoff } },
        select: { id: true, contractId: true },
      });
      if (stale.length === 0) return;

      await this.prisma.$transaction(async (tx) => {
        await tx.posTransaction.updateMany({
          where: { id: { in: stale.map((t) => t.id) }, status: 'PENDING' },
          data: { status: 'FAILED', cardToken: null },
        });
        for (const t of stale) {
          await this.audit.logWithTx(tx, {
            action: 'PAYMENT_FAILED',
            entityType: 'POS_TRANSACTION',
            entityId: t.id,
            contractId: t.contractId,
            meta: { reasonCode: 'ABANDONED' },
          });
        }
      });
      this.logger.log(
        `${stale.length} yarıda kalan ödeme kapatıldı, kart verisi silindi`,
      );
    } catch (err) {
      this.logger.error(
        `Yarıda kalan ödeme temizliği başarısız: ${(err as Error).message}`,
      );
    }
  }
}
