import { Module } from '@nestjs/common';
import { FriendsModule } from '../friends/friends.module.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

/**
 * 会话与消息模块。
 *
 * 发消息前要过好友关系闸门 → import FriendsModule；
 * 网关（WsModule）注入 SessionsService 做落库与已读回执 → 导出本服务。
 */
@Module({
  imports: [FriendsModule],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
