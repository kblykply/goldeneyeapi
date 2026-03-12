# EUR Base Currency Rollout

## Preconditions
- DB snapshot/backup is taken.
- Application release includes schema and API changes from this branch.
- `GBP_TO_EUR_RATE` is set explicitly for reproducible conversion.

## Rollout Order
1. Deploy backend/frontend code that understands the new base-agnostic fields.
2. Run DB schema migration:
   - `npx prisma migrate deploy`
3. Seed EUR-based exchange rates:
   - `npm run seed:exchange-rates`
4. Run one-time GBP -> EUR conversion:
   - `GBP_TO_EUR_RATE=1.17 npm run migrate:eur-base`
5. Validate migration state:
   - `npm run validate:eur-base`
6. Seed week prices in EUR cents:
   - `npm run seed:week-prices`

## Smoke Test Checklist
- Presentation flow:
  - Week selection updates price correctly in `EUR` default.
  - Currency switch (`EUR/GBP/USD/TRY`) updates displayed values.
  - Installment plan total equals cash price and can proceed.
- Week prices admin:
  - Single-row edit works.
  - Bulk `%` update works for selected columns.
- Contract and commissions pages:
  - Contract total displays correctly.
  - Commission totals and list rows render without missing fields.

## Rollback
1. Stop write traffic if possible.
2. Restore DB from pre-migration snapshot.
3. Roll back application deployment to previous release.
4. Re-run health checks on presentation/contract/commission endpoints.
