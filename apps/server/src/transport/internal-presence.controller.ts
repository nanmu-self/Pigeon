import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WsEventsService } from '../ws/ws-events.service.js';
import { CallService } from '../call/call.service.js';
import { PresenceMirrorService } from './presence-mirror.service.js';
import { InternalTokenGuard } from './internal-token.guard.js';

/**
 * presence delta 落地（D6 入口 2）：Rust 在用户首连/末路断开时推送到这里。
 *
 * 镜像更新与广播在同一处发生（语义与旧网关一致：首连广播上线、末路广播离线）；
 * 末路断开同时终止该用户进行中的通话（对端收到 call:cancelled/ended），
 * 与 socket 网关 handleDisconnect 同语义、同顺序。
 */
@Controller('internal/presence')
@UseGuards(InternalTokenGuard)
export class InternalPresenceController {
  constructor(
    @Inject(PresenceMirrorService) private readonly mirror: PresenceMirrorService,
    @Inject(WsEventsService) private readonly events: WsEventsService,
    @Inject(CallService) private readonly calls: CallService,
  ) {}

  @Post('delta')
  @HttpCode(200)
  async delta(
    @Body() body: { epoch?: string; seq?: number; userId?: string; online?: boolean; at?: number },
  ): Promise<{ ok: true; applied: string }> {
    if (!body.epoch || !Number.isFinite(body.seq) || !body.userId) {
      throw new BadRequestException('epoch/seq/userId are required');
    }
    const applied = this.mirror.applyDelta({
      epoch: body.epoch,
      seq: body.seq as number,
      userId: body.userId,
      online: body.online === true,
    });
    if (applied === 'epoch-reset') {
      // Rust 重启：镜像异步重建中，本条 delta 的广播跳过（对端会全量对账）
      return { ok: true, applied };
    }
    if (applied === 'applied') {
      this.events.broadcast('presence:update', {
        userId: body.userId,
        online: body.online === true,
        at: body.at ?? Date.now(),
      });
      if (body.online !== true) {
        const numericUserId = Number(body.userId);
        if (Number.isInteger(numericUserId) && numericUserId > 0) {
          this.calls.handleUserOffline(numericUserId);
        }
      }
    }
    return { ok: true, applied };
  }
}
