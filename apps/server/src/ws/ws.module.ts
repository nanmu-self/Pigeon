import { Global, Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway.js';
import { WsEventsService } from './ws-events.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';

/**
 * Socket.IO 模块。
 *
 * 与 PrismaModule 同样声明为 @Global：任何模块都可以直接注入
 * `WsEventsService` 向客户端推送实时事件，无需重复 import。
 *
 * import SessionsModule：网关的 message:send / message:read 处理器
 * 依赖 SessionsService（落库、成员校验、已读回执）。
 */
@Global()
@Module({
  imports: [SessionsModule],
  providers: [WsEventsService, EventsGateway],
  exports: [WsEventsService],
})
export class WsModule {}
