import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module.js';
import { CallModule } from '../call/call.module.js';
import { InternalPresenceController } from './internal-presence.controller.js';
import { InternalRtController } from './internal-rt.controller.js';
import { TransportController } from './transport.controller.js';
import { PresenceMirrorService } from './presence-mirror.service.js';
import { TransportBridgeService } from './transport-bridge.service.js';
import { TransportCertService } from './transport-cert.service.js';
import { resolveTransportSettings } from './config.js';

/**
 * 实时传输模块（WebTransport 桥 + 内部端点 + 配置下发）。
 *
 *  - `/internal/rt/*`、`/internal/presence/delta`：内部端点（x-internal-token 防线），
 *    e2e 也经 supertest 打它们（D7：C2S 与传输实现解耦）；
 *  - `/transport/config`：客户端配置下发；
 *  - PresenceMirror / TransportBridge：presence 镜像与推送桥。
 *
 * WsModule 把 `WsEventsService` token 绑定到 TransportBridgeService（唯一实现）。
 */
@Module({
  imports: [SessionsModule, CallModule],
  controllers: [InternalRtController, InternalPresenceController, TransportController],
  providers: [PresenceMirrorService, TransportCertService, TransportBridgeService],
  exports: [PresenceMirrorService, TransportCertService, TransportBridgeService],
})
export class TransportModule implements OnApplicationBootstrap {
  /** 启动即校验传输配置（缺 JWT_SECRET 等 → 启动失败，fail-fast） */
  onApplicationBootstrap(): void {
    resolveTransportSettings();
  }
}
