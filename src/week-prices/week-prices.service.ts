import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

type UpdateWeekPriceData = {
  periodText?: string;
  pesinCents?: number;
  taksit6Cents?: number;
  taksit12Cents?: number;
};

type BulkUpdateItem = {
  id: string;
  data: UpdateWeekPriceData;
};

@Injectable()
export class WeekPricesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.weekPrice.findMany({
      orderBy: [{ unitType: "asc" }, { weekOfYear: "asc" }],
    });
  }

  async updateOne(id: string, data: UpdateWeekPriceData) {
    const existing = await this.prisma.weekPrice.findUnique({ where: { id } });
    if (!existing) return null;

    return this.prisma.weekPrice.update({
      where: { id },
      data,
    });
  }

  async bulkUpdate(items: BulkUpdateItem[]) {
    const updates = await this.prisma.$transaction(
      items.map(({ id, data }) =>
        this.prisma.weekPrice.update({ where: { id }, data })
      )
    );

    return { updatedCount: updates.length };
  }
}
