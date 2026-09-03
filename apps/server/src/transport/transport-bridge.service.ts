import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EventPayload, ServerToClientEvents } from '@pigeon/shared-types';
import { WsEventsService } from '../ws/ws-events.service.js';
import { PresenceMirrorService } from './presence-mirror.service.js';
import { resolveTransportSettings } from './config.js';

/** 单次 publish 的 HTTP 超时：业务事务不能被慢投递拖住 */
const PUBLISH_TIMEOUT_MS = 3_000;

/**
 * WebTransport 桥 —— WsEventsService token 的唯一实现（P4 起 Socket.IO 已删），
 * 内部把推送转为对 Rust 传输服务 `POST /internal/publish` 的调用。
 *
 * - fire-and-forget：不阻塞业务事务；失败重试 1 次，仍失败记数 + WARN。
 *   最终一致性依赖客户端 onConnected 全量对账（既有 REST 补偿链路）。
 * - isOnline/onlineCount 读本地 presence 镜像（PresenceMirrorService，D6）：
 *   同步、零延迟，mirror 数据来自 Rust 的 delta + 30s 对账。
 */
@Injectable()
export class TransportBridgeService implements WsEventsService {
  private readonly logger = new Logger(TransportBridgeService.name);
  /** 观测计数：publish 最终失败（重试后），供 /health 或日志告警消费 */
  publishFailedTotal = 0;
  publishSentTotal = 0;

  constructor(
    @Inject(PresenceMirrorService) private readonly mirror: PresenceMirrorService,
  ) {}

  /** 口径：在线用户数（去重），不是连接数 —— /health 响应里已注明 */
  get onlineCount(): number {
    return this.mirror.size;
  }

  isOnline(userId: string): boolean {
    return this.mirror.isOnline(userId);
  }

  toUser<K extends keyof ServerToClientEvents>(
    userId: string,
    event: K,
    payload: EventPayload<K>,
  ): void {
    this.publish({ users: [userId], broadcast: false, type: event, payload });
  }

  toUsers<K extends keyof ServerToClientEvents>(
    userIds: string[],
    event: K,
    payload: EventPayload<K>,
  ): void {
    if (userIds.length === 0) return;
    this.publish({ users: userIds, broadcast: false, type: event, payload });
  }

  broadcast<K extends keyof ServerToClientEvents>(
    event: K,
    payload: EventPayload<K>,
  ): void {
    this.publish({ users: [], broadcast: true, type: event, payload });
  }

  /** fire-and-forget 投递：失败重试 1 次（间隔 300ms），仍失败计数 + WARN */
  private publish(body: { users: string[]; broadcast: boolean; type: string; payload: unknown }): void {
    const settings = resolveTransportSettings();
    this.publishSentTotal += 1;
    void this.doPost(settings.internalUrl, settings.internalToken, body)
      .catch(() =>
        // 重试一次
        new Promise((resolve) => setTimeout(resolve, 300))
          .then(() => this.doPost(settings.internalUrl, settings.internalToken, body))
          .catch((error: unknown) => {
            this.publishFailedTotal += 1;
            this.logger.warn(
              `publish ${body.type} → ${body.broadcast ? 'broadcast' : body.users.join(',')} failed: ${String(error)}`,
            );
          }),
      );
  }

  private async doPost(internalUrl: string, token: string, body: unknown): Promise<void> {
    if (!token) throw new Error('WT_INTERNAL_TOKEN 未配置');
    const response = await fetch(`${internalUrl}/internal/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`transport returned ${response.status}`);
  }
}
