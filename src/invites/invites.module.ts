import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { InvitesController } from "./invites.controller";

@Module({
  imports: [PrismaModule],
  controllers: [InvitesController],
})
export class InvitesModule {}