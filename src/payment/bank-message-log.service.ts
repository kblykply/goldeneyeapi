import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { BankMessageOutcome, BankMessageService } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { maskBankPayload } from "./bank-message.mask";

export interface BankMessageRecord {
  service: BankMessageService;
  outcome: BankMessageOutcome;
  endpoint: string;
  requestBody: string;
  responseBody?: string;
  httpStatus?: number;
  durationMs?: number;
  posTransactionId?: string;
  mpiTransactionId?: string;
  contractId?: string;
  resultCode?: string;
  resultText?: string;
  hostReference?: string;
  errorMessage?: string;
}

// Varsayılan saklama süresi: 2 yıl. Kart verisi içermediği için (maskeli) uzun
// saklama sakıncalı değil; banka uyuşmazlıkları aylar sonra açılabildiğinden
// kısa tutmak kanıtı yok eder.
const DEFAULT_RETENTION_DAYS = 730;

/**
 * Bankayla yapılan her mesajlaşmayı kalıcı olarak kaydeder.
 *
 * İki değişmez kural:
 *  1) Gövdeler DAİMA maskelenerek yazılır — ham gövde bu servisin dışına çıkmaz.
 *  2) Log yazımı ödeme akışını asla bozmaz; hata yalnızca uygulama log'una düşer.
 */
@Injectable()
export class BankMessageLogService {
  private readonly logger = new Logger(BankMessageLogService.name);
  private readonly retentionDays: number;

  constructor(
    private prisma: PrismaService,
    config: ConfigService,
  ) {
    this.retentionDays = Number(
      config.get("BANK_LOG_RETENTION_DAYS", DEFAULT_RETENTION_DAYS),
    );
  }

  async record(entry: BankMessageRecord): Promise<void> {
    try {
      await this.prisma.bankMessageLog.create({
        data: {
          service: entry.service,
          outcome: entry.outcome,
          endpoint: entry.endpoint,
          requestBody: maskBankPayload(entry.requestBody),
          responseBody: entry.responseBody ? maskBankPayload(entry.responseBody) : null,
          httpStatus: entry.httpStatus ?? null,
          durationMs: entry.durationMs ?? null,
          posTransactionId: entry.posTransactionId ?? null,
          mpiTransactionId: entry.mpiTransactionId ?? null,
          contractId: entry.contractId ?? null,
          resultCode: entry.resultCode ?? null,
          resultText: entry.resultText ?? null,
          hostReference: entry.hostReference ?? null,
          errorMessage: entry.errorMessage ?? null,
        },
      });
    } catch (err: any) {
      // Kanıt kaydı yazılamadıysa bunu sessizce geçme — ama ödemeyi de düşürme
      this.logger.error(
        `Banka mesaj log'u yazılamadı (service=${entry.service} mpiTransactionId=${entry.mpiTransactionId}): ${err?.message}`,
      );
    }
  }

  // Saklama süresi dolan kayıtlar temizlenir (KVKK/PCI veri minimizasyonu).
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeExpired(): Promise<void> {
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
    try {
      const { count } = await this.prisma.bankMessageLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (count > 0) {
        this.logger.log(`${count} banka mesaj log'u saklama süresi dolduğu için silindi`);
      }
    } catch (err: any) {
      this.logger.error(`Banka mesaj log temizliği başarısız: ${err?.message}`);
    }
  }
}
