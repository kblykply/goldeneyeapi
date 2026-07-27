-- Bankayla yapılan mesajlaşmanın kalıcı kaydı (mutabakat/uyuşmazlık kanıtı).
-- Gövdeler MASKELİ yazılır: PAN ilk6+son4, CVV ve üye işyeri şifresi hiç saklanmaz.

CREATE TYPE "BankMessageService" AS ENUM ('MPI_ENROLLMENT', 'VPOS_PAYMENT', 'THREE_D_CALLBACK');
CREATE TYPE "BankMessageOutcome" AS ENUM ('SUCCESS', 'DECLINED', 'ERROR');

CREATE TABLE "bank_message_logs" (
  "id"               TEXT NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "service"          "BankMessageService" NOT NULL,
  "outcome"          "BankMessageOutcome" NOT NULL,
  "posTransactionId" TEXT,
  "mpiTransactionId" TEXT,
  "contractId"       TEXT,
  "endpoint"         TEXT NOT NULL,
  "httpStatus"       INTEGER,
  "durationMs"       INTEGER,
  "requestBody"      TEXT NOT NULL,
  "responseBody"     TEXT,
  "resultCode"       TEXT,
  "resultText"       TEXT,
  "hostReference"    TEXT,
  "errorMessage"     TEXT,

  CONSTRAINT "bank_message_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bank_message_logs_posTransactionId_idx" ON "bank_message_logs"("posTransactionId");
CREATE INDEX "bank_message_logs_mpiTransactionId_idx" ON "bank_message_logs"("mpiTransactionId");
CREATE INDEX "bank_message_logs_createdAt_idx"        ON "bank_message_logs"("createdAt");
CREATE INDEX "bank_message_logs_hostReference_idx"    ON "bank_message_logs"("hostReference");

-- İşlem kaydı silinse dahi banka mesajı kanıt olarak kalır
ALTER TABLE "bank_message_logs"
  ADD CONSTRAINT "bank_message_logs_posTransactionId_fkey"
  FOREIGN KEY ("posTransactionId") REFERENCES "pos_transactions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
