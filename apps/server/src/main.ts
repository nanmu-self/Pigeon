import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  // Ensure OnApplicationShutdown runs so the Prisma pool closes gracefully.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3048);
}
await bootstrap();
