import { Controller, Get, Inject } from '@nestjs/common';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  // Explicit token: esbuild/swc-based runners (vite, tsx) do not emit the
  // decorator metadata NestJS constructor injection relies on.
  constructor(@Inject(AppService) private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
