import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { MessageReadAck, WsChatMessage } from '@pigeon/shared-types';
import { HttpException } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service.js';
import { CallService } from '../call/call.service.js';
import { InternalTokenGuard } from './internal-token.guard.js';

/**
 * C2S 统一入口（§6.2）：POST /internal/rt/:type
 *
 * Rust 把 RPC 帧原样转发到这里：body = 事件载荷（与 Socket.IO 事件载荷同构），
 * 用户上下文走 x-user-id / x-display-name-b64 头（昵称可能含非 ASCII，header
 * 值只能是可见 ASCII，由 Rust base64url 编码、这里解码）。
 *
 * 响应恒 HTTP 200 + {ok, data|error}（业务错误走 body，Rust 据此组装 RtResponse；
 * 内部防线失败才走 401/404 让 Rust 记日志）。处理体自 events.gateway.ts 原样迁移，
 * 错误文案逐字一致（客户端 toast 依赖）。
 */
@Controller('internal/rt')
@UseGuards(InternalTokenGuard)
export class InternalRtController {
  private readonly logger = new Logger(InternalRtController.name);

  constructor(
    // swc 编译无装饰器元数据，注入一律显式 @Inject（与全仓库约定一致）
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(CallService) private readonly calls: CallService,
  ) {}

  /** Rust 转发的用户上下文头（guest 分支的 Number.isInteger 校验保留，防内部头伪造） */
  private userContext(request: Request): { userId: number; displayName: string } {
    const rawUserId = (request.headers['x-user-id'] as string | undefined) ?? '';
    const userId = Number(rawUserId);
    if (!Number.isInteger(userId) || userId <= 0) {
      // 旧网关此处是「游客不能…」系列文案；内部通道被伪造时统一为：
      throw new UnauthorizedException('登录状态异常');
    }
    const b64 = (request.headers['x-display-name-b64'] as string | undefined) ?? '';
    let displayName = rawUserId;
    if (b64) {
      try {
        displayName = Buffer.from(b64, 'base64url').toString('utf8');
      } catch {
        displayName = rawUserId;
      }
    }
    return { userId, displayName };
  }

  /** 把业务异常（HttpException）转成给客户端的 ack 文案 —— 与旧网关逐字一致 */
  private errorText(error: unknown): string {
    if (error instanceof HttpException) {
      const res = error.getResponse();
      if (typeof res === 'string') return res;
      return (res as { message?: string }).message ?? error.message;
    }
    this.logger.error(`internal rt handler failed: ${String(error)}`);
    return '服务器开小差了，请稍后再试';
  }

  @Post(':type')
  @HttpCode(200)
  async handle(
    @Req() request: Request,
    @Param('type') type: string,
    @Body() payload: unknown,
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    try {
      switch (type) {
        case 'message:send':
          return { ok: true, data: await this.onMessageSend(request, payload) };
        case 'message:read':
          return { ok: true, data: await this.onMessageRead(request, payload) };
        case 'reaction:add':
          return { ok: true, data: await this.onReactionAdd(request, payload) };
        case 'reaction:remove':
          return { ok: true, data: await this.onReactionRemove(request, payload) };
        case 'call:invite':
        case 'call:accept':
        case 'call:reject':
        case 'call:cancel':
        case 'call:hangup':
        case 'webrtc:signal':
          return { ok: true, data: this.onCallSignal(request, type, payload) };
        default:
          // typing/conversation 系列是协议保留位（D2 死代码确认），不实现
          throw new NotFoundException(`unknown rt type: ${type}`);
      }
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof NotFoundException) throw error;
      return { ok: false, error: this.errorText(error) };
    }
  }

  // ── 音视频通话信令（Socket.IO 路径 events.gateway.ts 同源：CallService） ──

  private async onCallSignal(
    request: Request,
    type: string,
    payload: unknown,
  ): Promise<{ callId: string; ringTimeoutMs: number } | { callId: string } | null> {
    const { userId, displayName } = this.userContext(request);
    const body = (payload ?? {}) as { callId?: string; targetUserId?: string; media?: 'audio' | 'video'; data?: never; reason?: string };
    switch (type) {
      case 'call:invite':
        return await this.calls.invite(userId, displayName, body);
      case 'call:accept':
        return this.calls.accept(userId, body);
      case 'call:reject':
        return this.calls.reject(userId, body);
      case 'call:cancel':
        return this.calls.cancel(userId, body);
      case 'call:hangup':
        return this.calls.hangup(userId, body);
      default:
        return this.calls.signal(userId, body);
    }
  }

  // ── 处理体（自 events.gateway.ts 原样迁移） ─────────────────

  private async onMessageSend(request: Request, payload: unknown): Promise<WsChatMessage> {
    const body = (payload ?? {}) as {
      conversationId?: string;
      content?: string;
      kind?: WsChatMessage['kind'];
      clientMsgId?: string;
      meta?: Record<string, unknown>;
      replyToId?: string;
      mentions?: string[];
    };
    const { conversationId, content, kind, clientMsgId, meta, replyToId, mentions } = body;
    if (!conversationId || !content?.trim()) {
      throw new BadRequestException('conversationId and content are required');
    }
    const { userId: senderId, displayName } = this.userContext(request);
    const sessionId = Number(conversationId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      throw new BadRequestException('会话不存在');
    }
    if (kind && !['text', 'image', 'file'].includes(kind)) {
      throw new BadRequestException('不支持的消息类型');
    }
    // 引用回复：string → number（服务端校验存在性/同会话）
    let replyToIdNum: number | undefined;
    if (replyToId !== undefined) {
      replyToIdNum = Number(replyToId);
      if (!Number.isInteger(replyToIdNum) || replyToIdNum <= 0) {
        throw new BadRequestException('replyToId 非法');
      }
    }
    return this.sessions.sendMessage({
      sessionId,
      senderId,
      senderName: displayName,
      content,
      kind: kind ?? 'text',
      ...(clientMsgId ? { clientMsgId } : {}),
      ...(meta ? { meta } : {}),
      ...(replyToIdNum !== undefined ? { replyToId: replyToIdNum } : {}),
      ...(mentions?.length ? { mentions } : {}),
    });
  }

  private async onMessageRead(request: Request, payload: unknown): Promise<MessageReadAck> {
    const body = (payload ?? {}) as { conversationId?: string };
    const { userId: readerId } = this.userContext(request);
    const sessionId = Number(body.conversationId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      throw new BadRequestException('会话不存在');
    }
    return this.sessions.markRead(readerId, sessionId);
  }

  private async onReactionAdd(request: Request, payload: unknown): Promise<null> {
    const body = (payload ?? {}) as { conversationId?: string; messageId?: string; emoji?: string };
    const { userId } = this.userContext(request);
    const conversationId = Number(body.conversationId);
    const messageId = Number(body.messageId);
    if (!Number.isInteger(conversationId) || !Number.isInteger(messageId)) {
      throw new BadRequestException('conversationId and messageId are required');
    }
    await this.sessions.addReaction(userId, conversationId, messageId, body.emoji ?? '');
    return null;
  }

  private async onReactionRemove(request: Request, payload: unknown): Promise<null> {
    const body = (payload ?? {}) as { conversationId?: string; messageId?: string; emoji?: string };
    const { userId } = this.userContext(request);
    const conversationId = Number(body.conversationId);
    const messageId = Number(body.messageId);
    if (!Number.isInteger(conversationId) || !Number.isInteger(messageId)) {
      throw new BadRequestException('conversationId and messageId are required');
    }
    await this.sessions.removeReaction(userId, conversationId, messageId, body.emoji ?? '');
    return null;
  }
}
