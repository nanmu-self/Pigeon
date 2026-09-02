import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module.js';
import { InternalPresenceController } from './internal-presence.controller.js';
import { InternalRtController } from './internal-rt.controller.js';
import { TransportController } from './transport.controller.js';
import { PresenceMirrorService } from './presence-mirror.service.js';
import { TransportBridgeService } from './transport-bridge.service.js';
import { TransportCertService } from './transport-cert.service.js';

/**
 * 实时传输模块（WebTransport 桥 + 内部端点 + 配置下发）。
 *
 * 始终挂载（与传输模式无关）：
 *  - `/internal/rt/*`、`/internal/presence/delta`：内部端点（x-internal-token 防线），
 *    e2e 也经 supertest 打它们（D7：C2S 与传输实现解耦）；
 *  - `/transport/config`：客户端配置下发；
 *  - PresenceMirror / TransportBridge：wt 模式的 presence 镜像与推送桥。
 *
 * WsModule 按 RT_TRANSPORT 决定把 `WsEventsService` token 指向谁：
 *  - socket（默认）→ 旧 WsEventsService（Socket.IO 桥）
 *  - wt            → useExisting: TransportBridgeService（HTTP 桥）
 */
@Module({
  imports: [SessionsModule],
  controllers: [InternalRtController, InternalPresenceController, TransportController],
  providers: [PresenceMirrorService, TransportCertService, TransportBridgeService],
  exports: [PresenceMirrorService, TransportCertService, TransportBridgeService],
})
export class TransportModule {}
