import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { AuthGuard } from "./auth/auth.guard";
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
import { AuditModule } from "./audit/audit.module";

import { CurrencyModule } from "./currency/currency.module";
import { WeekPricesModule } from "./week-prices/week-prices.module";
import { CustomersModule } from "./customers/customers.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { ApartmentsModule } from "./apartments/apartments.module";
import { NewsModule } from "./news/news.module";
import { BlogModule } from "./blog/blog.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuditModule,
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
    CurrencyModule,
    WeekPricesModule,
    CustomersModule,
    NotificationsModule,
    ApartmentsModule,
    NewsModule,
    BlogModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}