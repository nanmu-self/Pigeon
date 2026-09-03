import 'dotenv/config'; // 读取 .env（PORT / CLIENT_ORIGINS 等；Prisma 侧各自也有加载）
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';
import { allowedOrigins } from './config.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  // Ensure OnApplicationShutdown runs so the Prisma pool closes gracefully.
  app.enableShutdownHooks();
  // 入参校验：剥离/拒绝未声明字段，校验失败统一 400（class-validator DTO）
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  // Tauri webview 直连（alova fetch），生产包 origin 因平台而异 → 统一走 allowedOrigins()。
  app.enableCors({ origin: allowedOrigins(), credentials: true });

  await app.listen(process.env.PORT ?? 3048);
  console.log(`HTTP  → ${await app.getUrl()}`);
  // 实时通道：WebTransport（Rust 网关 apps/transport-server，UDP 4433）。
  // 本进程只提供 /internal/rt/* 与 /transport/config，推送经 /internal/publish 转发。
  console.log(
    `RT    → ${process.env.WT_PUBLIC_URL ?? '(WT_PUBLIC_URL 未配置)'} (webtransport, bridge: ${process.env.TRANSPORT_INTERNAL_URL ?? 'http://127.0.0.1:3901'})`,
  );
}
await bootstrap();
