import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FriendItem, FriendRequestItem } from '@pigeon/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { FriendsService } from './friends.service.js';
import { SendFriendRequestDto } from './dto.js';

/** 挂载了 JwtPayload 的请求（由 JwtAuthGuard 写入 request.user） */
interface AuthedRequest {
  user: JwtPayload;
}

/**
 * 好友关系接口 — 全部需要登录。
 *
 * 路由按「申请/关系」两个维度组织：
 *   GET    /friends                  好友列表（含在线状态）
 *   GET    /friends/requests         待处理申请（收到的 + 发出的）
 *   POST   /friends/requests         发起申请
 *   POST   /friends/requests/:id/accept   通过（仅被申请方）
 *   POST   /friends/requests/:id/decline  拒绝（仅被申请方，删行）
 *   DELETE /friends/:userId          删除好友（任意状态）
 *   POST   /friends/:userId/block    拉黑
 *   POST   /friends/:userId/unblock  解除拉黑
 */
@Controller('friends')
@UseGuards(JwtAuthGuard)
export class FriendsController {
  constructor(
    // swc 编译无装饰器元数据，注入一律显式 @Inject（与全仓库约定一致）
    @Inject(FriendsService) private readonly friends: FriendsService,
  ) {}

  @Get()
  list(@Req() req: AuthedRequest): Promise<FriendItem[]> {
    return this.friends.listFriends(req.user.userId);
  }

  @Get('requests')
  listRequests(@Req() req: AuthedRequest): Promise<FriendRequestItem[]> {
    return this.friends.listRequests(req.user.userId);
  }

  @Post('requests')
  @HttpCode(201)
  sendRequest(@Req() req: AuthedRequest, @Body() dto: SendFriendRequestDto): Promise<FriendRequestItem> {
    return this.friends.sendRequest(req.user.userId, dto.userId);
  }

  @Post('requests/:id/accept')
  accept(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<FriendItem> {
    return this.friends.accept(req.user.userId, id);
  }

  @Post('requests/:id/decline')
  @HttpCode(204)
  async decline(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.friends.decline(req.user.userId, id);
  }

  @Delete(':userId')
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('userId', ParseIntPipe) userId: number): Promise<void> {
    await this.friends.remove(req.user.userId, userId);
  }

  @Post(':userId/block')
  @HttpCode(204)
  async block(@Req() req: AuthedRequest, @Param('userId', ParseIntPipe) userId: number): Promise<void> {
    await this.friends.block(req.user.userId, userId);
  }

  @Post(':userId/unblock')
  @HttpCode(204)
  async unblock(@Req() req: AuthedRequest, @Param('userId', ParseIntPipe) userId: number): Promise<void> {
    await this.friends.unblock(req.user.userId, userId);
  }
}
