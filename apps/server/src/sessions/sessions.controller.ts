import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Query,
  DefaultValuePipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { MessageHistoryPage, MessageReadAck, SessionSummary } from '@pigeon/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { SessionsService } from './sessions.service.js';
import { CreateSessionDto } from './dto.js';

/** 挂载了 JwtPayload 的请求（由 JwtAuthGuard 写入 request.user） */
interface AuthedRequest {
  user: JwtPayload;
}

/**
 * 会话与消息接口 — 全部需要登录。
 *
 *   GET  /sessions                    会话列表（对端 + 在线 + 预览 + 未读数）
 *   POST /sessions                    好友间建会话（幂等）
 *   GET  /sessions/:id/messages       历史消息（keyset 游标分页，正序返回）
 *   POST /sessions/:id/read           标记已读（推已读回执给对端）
 */
@Controller('sessions')
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(
    // swc 编译无装饰器元数据，注入一律显式 @Inject（与全仓库约定一致）
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  @Get()
  list(@Req() req: AuthedRequest): Promise<SessionSummary[]> {
    return this.sessions.list(req.user.userId);
  }

  @Post()
  @HttpCode(201)
  createOrGet(@Req() req: AuthedRequest, @Body() dto: CreateSessionDto): Promise<SessionSummary> {
    return this.sessions.createOrGet(req.user.userId, dto.peerId);
  }

  @Get(':id/messages')
  history(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    /** 游标：上一页最早一条消息的 id（不传 = 从最新开始）；手动解析以支持可选缺省 */
    @Query('cursor') rawCursor: string | undefined,
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit: number,
  ): Promise<MessageHistoryPage> {
    let cursor: number | null = null;
    if (rawCursor !== undefined && rawCursor !== '') {
      cursor = Number(rawCursor);
      if (!Number.isInteger(cursor) || cursor <= 0) {
        throw new BadRequestException('cursor 必须是正整数消息 id');
      }
    }
    return this.sessions.getHistory(req.user.userId, id, cursor, limit);
  }

  @Post(':id/read')
  markRead(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<MessageReadAck> {
    return this.sessions.markRead(req.user.userId, id);
  }
}
