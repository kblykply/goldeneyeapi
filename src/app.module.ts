import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { MeModule } from "./me/me.module";
import { AuthorityModule } from "./authority/authority.module";
import { PresentationsModule } from "./presentations/presentations.module";
import { PresenceModule } from "./presence/presence.module";
import { TeamModule } from "./team/team.module";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { UsersModule } from "./users/users.module";
import { ContractsModule } from "./contracts/contracts.module";

import { CommissionsModule } from "./commissions/commissions.module";
import { SmsModule } from "./sms/sms.module";

import { InvitesModule } from "./invites/invites.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    MeModule,
    AuthorityModule,
    PresentationsModule,
    PresenceModule,
    TeamModule,
    UsersModule,
    ContractsModule,
    CommissionsModule,
        SmsModule,
        InvitesModule,

  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}