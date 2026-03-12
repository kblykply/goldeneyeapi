ALTER TABLE "WeekPrice" RENAME COLUMN "pesinCents" TO "cashCents";
ALTER TABLE "WeekPrice" RENAME COLUMN "taksit6Cents" TO "installment6Cents";
ALTER TABLE "WeekPrice" RENAME COLUMN "taksit12Cents" TO "installment12Cents";

ALTER TABLE "Presentation" RENAME COLUMN "priceCents" TO "basePriceCents";
ALTER TABLE "Contract" RENAME COLUMN "priceCents" TO "basePriceCents";
ALTER TABLE "Commission" RENAME COLUMN "amountCents" TO "baseAmountCents";
ALTER TABLE "custom_payment_plans" RENAME COLUMN "totalCents" TO "baseTotalCents";
ALTER TABLE "custom_payment_installments" RENAME COLUMN "amountCents" TO "baseAmountCents";
