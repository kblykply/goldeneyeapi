import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class TeamService {
  constructor(private prisma: PrismaService) {}

  // returns all user ids in subtree (root included)
  async getSubtreeIds(rootId: string): Promise<Set<string>> {
    const visited = new Set<string>([rootId]);
    let frontier = [rootId];

    while (frontier.length > 0) {
      const children = await this.prisma.user.findMany({
        where: { leaderId: { in: frontier } },
        select: { id: true },
      });

      const next: string[] = [];
      for (const c of children) {
        if (!visited.has(c.id)) {
          visited.add(c.id);
          next.push(c.id);
        }
      }
      frontier = next;
    }

    return visited;
  }
}