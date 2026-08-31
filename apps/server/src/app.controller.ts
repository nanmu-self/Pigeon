import { Controller, Get, Inject } from '@nestjs/common';
import { AppService } from './app.service.js';
import { WsEventsService } from './ws/ws-events.service.js';

@Controller()
export class AppController {
  // Explicit token: esbuild/swc-based runners (vite, tsx) do not emit the
  // decorator metadata NestJS constructor injection relies on.
  constructor(
    @Inject(AppService) private readonly appService: AppService,
    @Inject(WsEventsService) private readonly wsEvents: WsEventsService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** 客户端探活（alova 轮询测延迟 / 启动检查可达性） */
  @Get('health')
  getHealth() {
    return this.appService.getHealth(this.wsEvents.onlineCount);
  }
}
