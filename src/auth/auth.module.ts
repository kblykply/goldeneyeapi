import { Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthController } from "./auth.controller";

@Global()
@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("JWT_ACCESS_SECRET"),
        signOptions: { expiresIn: "2h" },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  exports: [JwtModule],
})
export class AuthModule {}
