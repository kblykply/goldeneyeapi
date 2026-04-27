import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { NewsController } from "./news.controller";

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [NewsController],
})
export class NewsModule {}
