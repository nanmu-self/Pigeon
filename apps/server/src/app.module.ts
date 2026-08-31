import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { PrismaModule } from './prisma.module.js';
import { FriendsModule } from './friends/friends.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { StorageModule } from './storage/storage.module.js';
import { UsersModule } from './users/users.module.js';
import { WsModule } from './ws/ws.module.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    PrismaModule,
    // 注册 / 登录(JWT 签发)
    AuthModule,
    // Socket.IO 实时通道（Tauri 前端直连）
    WsModule,
    // 七牛云 Kodo 直传取票（后端签凭证，前端 qiniu-js 直传）
    StorageModule,
    // 用户资料（GET/PATCH /users/me，JWT 鉴权）
    UsersModule,
    // 好友关系（搜索/申请/通过/拉黑/删除，好友列表带在线状态）
    FriendsModule,
    // 会话与消息（建会话/历史/已读回执；WS 消息落库也在其中）
    SessionsModule,
    // 群聊（建群/邀请/踢出/转让/公告/禁言/成员列表）
    GroupsModule,
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? '',
      appSecret: process.env.OBSERVE_APP_SECRET ?? '',
      serviceId: 'nest-typescript-starter',
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
