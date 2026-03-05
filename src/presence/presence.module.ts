import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { PresenceController } from "./presence.controller";

@Module({
  imports: [PrismaModule],
  controllers: [PresenceController],
})
export class PresenceModule {}