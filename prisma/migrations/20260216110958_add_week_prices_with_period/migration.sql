-- CreateTable
CREATE TABLE "WeekPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "unitType" TEXT NOT NULL,
    "weekOfYear" INTEGER NOT NULL,
    "periodText" TEXT NOT NULL,
    "pesinCents" INTEGER NOT NULL,
    "taksit6Cents" INTEGER NOT NULL,
    "taksit12Cents" INTEGER NOT NULL
);

-- CreateIndex
CREATE INDEX "WeekPrice_unitType_idx" ON "WeekPrice"("unitType");

-- CreateIndex
CREATE INDEX "WeekPrice_weekOfYear_idx" ON "WeekPrice"("weekOfYear");

-- CreateIndex
CREATE UNIQUE INDEX "WeekPrice_unitType_weekOfYear_key" ON "WeekPrice"("unitType", "weekOfYear");
