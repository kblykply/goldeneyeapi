-- TL karşılığı tahsilat alanları: fiyatlar EUR, bankaya kur çevrimiyle TL (949) gönderilir
ALTER TABLE "pos_transactions"
  ADD COLUMN "chargedCurrency" TEXT,
  ADD COLUMN "chargedAmountCents" INTEGER,
  ADD COLUMN "fxRate" DECIMAL(12,6),
  ADD COLUMN "fxRateSource" TEXT,
  ADD COLUMN "fxRateAt" TIMESTAMP(3);
