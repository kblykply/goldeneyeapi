import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthController } from "./auth.controller";

@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
})
export class AuthModule {}