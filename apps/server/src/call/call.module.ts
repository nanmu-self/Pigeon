import { Module } from '@nestjs/common';
import { CallService } from './call.service.js';
import { FriendsModule } from '../friends/friends.module.js';

/**
 * 音视频通话信令（1:1，WebRTC P2P 媒体）。
 *
 * FriendsModule：assertFriends 是呼叫闸门（与发消息同源）；
 * WsEventsService 由 @Global 的 WsModule 提供，无需 import。
 */
@Module({
  imports: [FriendsModule],
  providers: [CallService],
  exports: [CallService],
})
export class CallModule {}
