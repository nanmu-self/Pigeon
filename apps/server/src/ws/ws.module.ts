import { Global, Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway.js';
import { WsEventsService } from './ws-events.service.js';

/**
 * Socket.IO 模块。
 *
 * 与 PrismaModule 同样声明为 @Global：任何模块都可以直接注入
 * `WsEventsService` 向客户端推送实时事件，无需重复 import。
 */
@Global()
@Module({
  providers: [WsEventsService, EventsGateway],
  exports: [WsEventsService],
})
export class WsModule {}
