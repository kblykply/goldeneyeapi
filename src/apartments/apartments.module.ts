import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { ApartmentsController } from "./apartments.controller";

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [ApartmentsController],
})
export class ApartmentsModule {}
