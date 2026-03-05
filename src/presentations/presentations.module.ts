import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { PresentationsController } from "./presentations.controller";

@Module({
  imports: [PrismaModule],
  controllers: [PresentationsController],
})
export class PresentationsModule {}