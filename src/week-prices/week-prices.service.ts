import { Injectable } from "@nestjs/common";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { PrismaService } from "../prisma/prisma.service";

type UpdateWeekPriceData = {
  periodText?: string;
  cashCents?: number;
  installment6Cents?: number;
  installment12Cents?: number;
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
    try {
      return await this.prisma.weekPrice.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === "P2025") return null;
      throw e;
    }
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
