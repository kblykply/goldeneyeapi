import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthorityController } from "./authority.controller";
import { CommissionsModule } from "../commissions/commissions.module";

@Module({
  imports: [PrismaModule, CommissionsModule],
  controllers: [AuthorityController],
})
export class AuthorityModule {}