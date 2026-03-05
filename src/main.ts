import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import * as express from "express";
import { join } from "path";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Allow requests from Next.js dev server
  app.enableCors({
    origin: "http://localhost:3000",
    credentials: true,
  });

  // Ensures DTO validation + strips unknown fields + transforms types
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    })
  );



    app.use("/uploads", express.static(join(process.cwd(), "uploads")));


    
  await app.listen(4000);
  console.log("API running on http://localhost:4000");
}

bootstrap();