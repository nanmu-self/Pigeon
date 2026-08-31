import 'dotenv/config'; // 读取 .env（PORT / CLIENT_ORIGINS 等；Prisma 侧各自也有加载）
import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';
import { allowedOrigins } from './config.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  // Ensure OnApplicationShutdown runs so the Prisma pool closes gracefully.
  app.enableShutdownHooks();

  // Tauri webview 直连（alova fetch），生产包 origin 因平台而异 → 统一走 allowedOrigins()
  app.enableCors({ origin: allowedOrigins(), credentials: true });

  await app.listen(process.env.PORT ?? 3048);
  console.log(`HTTP  → ${await app.getUrl()}`);
  console.log(`WS    → ${await app.getUrl()} (socket.io, path: /socket.io)`);
}
await bootstrap();
