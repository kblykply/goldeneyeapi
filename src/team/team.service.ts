import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class TeamService {
  constructor(private prisma: PrismaService) {}

  // returns all user ids in subtree (root included) — single recursive CTE query
  async getSubtreeIds(rootId: string): Promise<Set<string>> {
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
    return new Set(rows.map((r) => r.id));
  }
}