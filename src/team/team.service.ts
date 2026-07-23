import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../cache/cache.service";

// Lider/isActive değişimlerinde users.controller "subtree:" önekini topluca düşürür
const SUBTREE_CACHE_TTL_MS = 60_000;

@Injectable()
export class TeamService {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  // returns all user ids in subtree (root included) — single recursive CTE query
  async getSubtreeIds(rootId: string): Promise<Set<string>> {
    const ids = await this.cache.getOrSet(`subtree:${rootId}`, SUBTREE_CACHE_TTL_MS, async () => {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE subtree AS (
          SELECT id FROM "User" WHERE id = ${rootId}
          UNION ALL
          SELECT u.id FROM "User" u
          INNER JOIN subtree s ON u."leaderId" = s.id
          WHERE u."isActive" = true
        )
        SELECT id FROM subtree
      `;
      return rows.map((r) => r.id);
    });
    // Çağıranlar Set'i mutate edebilir; cache'teki diziyi paylaşmamak için kopya dön
    return new Set(ids);
  }

  // returns the user + all ancestors up the leaderId chain — single recursive CTE, UNION deduplicates cycles
  async getAncestorIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE ancestors AS (
        SELECT id, "leaderId" FROM "User" WHERE id = ${userId}
        UNION
        SELECT u.id, u."leaderId" FROM "User" u
        INNER JOIN ancestors a ON u.id = a."leaderId"
      )
      SELECT id FROM ancestors
    `;
    return rows.map((r) => r.id);
  }
}