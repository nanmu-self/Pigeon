import { Global, Module } from '@nestjs/common';
import { TransportModule } from '../transport/transport.module.js';
import { TransportBridgeService } from '../transport/transport-bridge.service.js';
import { WsEventsService } from './ws-events.service.js';

/**
 * 实时推送注入面（@Global）：把 `WsEventsService` token 绑定到
 * TransportBridgeService（WebTransport HTTP 桥，唯一实现；P4 起 Socket.IO 已删）。
 * 任何模块都可以直接注入 `WsEventsService` 向客户端推送，无需重复 import。
 *
 * e2e 用 overrideProvider(WsEventsService) 换成 FakeTransportBridge（决策 D7）。
 */
@Global()
@Module({
  imports: [TransportModule],
  providers: [{ provide: WsEventsService, useExisting: TransportBridgeService }],
  exports: [WsEventsService],
})
export class WsModule {}
