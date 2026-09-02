import { DynamicModule, Global, Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway.js';
import { WsEventsService } from './ws-events.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { CallModule } from '../call/call.module.js';
import { TransportModule } from '../transport/transport.module.js';
import { TransportBridgeService } from '../transport/transport-bridge.service.js';
import { resolveTransportSettings } from '../transport/config.js';

/**
 * Socket.IO 模块（RT_TRANSPORT 开关，决策 D5）。
 *
 * 与 PrismaModule 同样声明为 @Global：任何模块都可以直接注入
 * `WsEventsService` 向客户端推送实时事件，无需重复 import。
 *
 * - `RT_TRANSPORT=socket`（默认）：挂载 Socket.IO 网关，WsEventsService 即旧实现。
 * - `RT_TRANSPORT=wt`：网关不挂载；`WsEventsService` token 由 useExisting 指向
 *   TransportBridgeService（HTTP 桥），7 处 isOnline 调用点、全部 toUser 调用点零改动。
 *
 * import SessionsModule：消息落库/成员校验/已读回执（网关与 internal-rt 控制器共用）。
 */
@Global()
@Module({})
export class WsModule {
  static register(): DynamicModule {
    const settings = resolveTransportSettings(); // wt 模式缺配置 → 启动即抛（fail-fast）
    if (settings.mode === 'wt') {
      return {
        global: true,
        module: WsModule,
        imports: [SessionsModule, TransportModule, CallModule],
        providers: [{ provide: WsEventsService, useExisting: TransportBridgeService }],
        exports: [WsEventsService],
      };
    }
    return {
      global: true,
      module: WsModule,
      imports: [SessionsModule, CallModule],
      providers: [WsEventsService, EventsGateway],
      exports: [WsEventsService],
    };
  }
}
