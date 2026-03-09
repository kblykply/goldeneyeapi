import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

// Absolute commission rates by (effective) level
const RATE_BY_LEVEL: Record<number, number> = {
  1: 0.16,
  2: 0.18,
  3: 0.20,
};

// REGIONAL_MANAGER absolute rate (top of chain)
const RM_RATE = 0.22;

@Injectable()
export class CommissionService {
  constructor(private prisma: PrismaService) {}

  /**
   * Call after Contract becomes APPROVED.
   * Idempotent per contract: if commissions already exist, it does nothing.
   *
   * Chain walks up from salesperson → leader → ... stopping at ADMIN.
   * Delta rates:
   *   L1 sells: L1=16%, L2=2%, L3=2%, RM=2%  → total 22%
   *   L2 sells: L2=18%, L3=2%, RM=2%          → total 22%
   *   L3 sells: L3=20%, RM=2%                 → total 22%
   */
  async calculateForApprovedContract(contractId: string) {
    const existing = await this.prisma.commission.count({
      where: { contractId },
    });
    if (existing > 0) return { ok: true, skipped: true };

    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: { id: true, status: true, priceCents: true, salespersonId: true },
    });

    if (!contract) return { ok: false, message: "Contract not found" };
    if (contract.status !== "APPROVED") return { ok: false, message: "Contract not APPROVED" };

    const priceCents = contract.priceCents;

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
        select: { id: true, role: true, level: true, leaderId: true },
      });

      if (!u) break;

      // ADMIN komisyon almaz, zincir durur
      if (u.role === "ADMIN") break;

      let absoluteRate: number;
      let effectiveLevel: number;

      if (u.role === "REGIONAL_MANAGER") {
        absoluteRate = RM_RATE; // %22
        effectiveLevel = 4;     // RM'yi level 4 olarak sakla
      } else {
        effectiveLevel = u.level >= 3 ? 3 : u.level;
        absoluteRate = RATE_BY_LEVEL[effectiveLevel];
        if (!absoluteRate) {
          currentUserId = u.leaderId ?? null;
          continue;
        }
      }

      const deltaRate = absoluteRate - lastPaidAbsoluteRate;

      if (deltaRate > 0) {
        const amountCents = Math.round(priceCents * deltaRate);

        await this.prisma.commission.create({
          data: {
            contractId: contract.id,
            userId: u.id,
            level: effectiveLevel,
            rate: deltaRate,
            amountCents,
            status: "PENDING",
          },
        });

        lastPaidAbsoluteRate = absoluteRate;
      }

      // RM'den sonra zincir durur (ADMIN komisyon almaz zaten)
      if (u.role === "REGIONAL_MANAGER") break;

      currentUserId = u.leaderId ?? null;
    }

    return { ok: true, skipped: false };
  }
}
