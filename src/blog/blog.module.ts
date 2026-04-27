import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { BlogController } from "./blog.controller";

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [BlogController],
})
export class BlogModule {}
