import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../cache/cache.service";

const CONFIG_CACHE_KEY = "commission:config";
const CONFIG_CACHE_TTL_MS = 10 * 60_000;

@Injectable()
export class CommissionService {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  /**
   * Singleton config — DB'den yükle, yoksa defaults ile oluştur.
   */
  async getConfig() {
    return this.cache.getOrSet(CONFIG_CACHE_KEY, CONFIG_CACHE_TTL_MS, async () => {
      const existing = await this.prisma.commissionConfig.findUnique({
        where: { id: "singleton" },
      });
      if (existing) return existing;
      return this.prisma.commissionConfig.create({ data: { id: "singleton" } });
    });
  }

  invalidateConfigCache() {
    this.cache.del(CONFIG_CACHE_KEY);
  }

  /**
   * Call after Contract becomes APPROVED.
   * Idempotent per contract: if commissions already exist, it does nothing.
   *
   * Chain walks up from salesperson → leader → ... stopping at ADMIN.
   * Delta rates (default config):
   *   L1 sells: L1=10%, L2=2.5%, L3=2.5%, RM=7.5%, ADMIN=3.5% → total 26%
   *   L2 sells: L2=12.5%, L3=2.5%, RM=7.5%, ADMIN=3.5%       → total 26%
   *   L3 sells: L3=15%, RM=7.5%, ADMIN=3.5%                   → total 26%
   *   AGENCY subtree: same lvl rates, AGENCY=20% cap
   *   SPECIAL: fixed rate + delta to creator up to rmRate
   */
  async calculateForApprovedContract(contractId: string) {
    const existing = await this.prisma.commission.count({
      where: { contractId },
    });
    if (existing > 0) return { ok: true, skipped: true };

    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: { id: true, status: true, basePriceCents: true, salespersonId: true },
    });

    if (!contract) return { ok: false, message: "Contract not found" };
    if (contract.status !== "APPROVED") return { ok: false, message: "Contract not APPROVED" };

    const config = await this.getConfig();
    const basePriceCents = contract.basePriceCents;

    let currentUserId: string | null = contract.salespersonId;
    let lastPaidAbsoluteRate = 0;

    const visited = new Set<string>();
    let hops = 0;
    const MAX_HOPS = 25;

    while (currentUserId) {
      hops += 1;
      if (hops > MAX_HOPS) break;

      if (visited.has(currentUserId)) break;
      visited.add(currentUserId);

      const u = await this.prisma.user.findUnique({
        where: { id: currentUserId },
        select: { id: true, role: true, level: true, leaderId: true, commissionRate: true },
      });

      if (!u) break;

      let absoluteRate: number;
      let effectiveLevel: number;

      if (u.role === "REGIONAL_MANAGER") {
        absoluteRate = config.rmRate;
        effectiveLevel = 4;
      } else if ((u.role as string) === "REGIONAL_LEADER") {
        absoluteRate = (config as any).rlRate;
        effectiveLevel = 4;
      } else if (u.role === "ADMIN") {
        absoluteRate = config.adminRate;
        effectiveLevel = 7;
      } else if (u.role === "AGENCY") {
        absoluteRate = config.agencyRate;
        effectiveLevel = 5;
      } else if (u.role === "SPECIAL") {
        absoluteRate = u.commissionRate ?? 0;
        effectiveLevel = 6;
        // SPECIAL için break YOK — zincir creator'a devam eder
      } else {
        // USER
        const lvl = u.level >= 3 ? 3 : u.level;
        const rateMap: Record<number, number> = {
          1: config.lvl1Rate,
          2: config.lvl2Rate,
          3: config.lvl3Rate,
        };
        absoluteRate = rateMap[lvl];
        effectiveLevel = lvl;
        if (!absoluteRate) {
          currentUserId = u.leaderId ?? null;
          continue;
        }
      }

      const deltaRate = absoluteRate - lastPaidAbsoluteRate;

      if (deltaRate > 0) {
        const baseAmountCents = Math.round(basePriceCents * deltaRate);

        await this.prisma.commission.create({
          data: {
            contractId: contract.id,
            userId: u.id,
            level: effectiveLevel,
            rate: deltaRate,
            baseAmountCents,
            status: "PENDING",
          },
        });

        lastPaidAbsoluteRate = absoluteRate;
      }

      // ADMIN'den sonra zincir durur; RM'den sonra ADMIN'e devam eder
      if (u.role === "ADMIN") break;

      currentUserId = u.leaderId ?? null;
    }

    return { ok: true, skipped: false };
  }
}
