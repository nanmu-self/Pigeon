import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { GroupDetail, SessionSummary } from '@pigeon/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { GroupsService } from './groups.service.js';
import {
  CreateGroupDto,
  InviteMembersDto,
  UpdateAnnouncementDto,
  UpdateGroupDto,
  UpdateMuteDto,
} from './dto.js';

/** 挂载了 JwtPayload 的请求（由 JwtAuthGuard 写入 request.user） */
interface AuthedRequest {
  user: JwtPayload;
}

/**
 * 群聊接口 — 全部需要登录。
 *
 *   POST   /groups                        建群（创建者为群主）
 *   GET    /groups/:id                    群详情（资料+公告+成员+在线状态）
 *   PATCH  /groups/:id                    改群名/头像（群主/管理员）
 *   PUT    /groups/:id/announcement       发布公告（群主/管理员）
 *   PUT    /groups/:id/mute               全员禁言开关（群主/管理员）
 *   POST   /groups/:id/members            邀请成员（群主/管理员）
 *   DELETE /groups/:id/members/:userId    踢出成员（群主/管理员，角色规则见服务）
 *   POST   /groups/:id/members/:userId/transfer  转让群主（仅群主）
 *   POST   /groups/:id/leave              退出群聊（群主需先转让）
 */
@Controller('groups')
@UseGuards(JwtAuthGuard)
export class GroupsController {
  constructor(
    // swc 编译无装饰器元数据，注入一律显式 @Inject（与全仓库约定一致）
    @Inject(GroupsService) private readonly groups: GroupsService,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Req() req: AuthedRequest, @Body() dto: CreateGroupDto): Promise<SessionSummary> {
    return this.groups.create(req.user.userId, dto.name, dto.memberIds);
  }

  @Get(':id')
  detail(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<GroupDetail> {
    return this.groups.detail(req.user.userId, id);
  }

  @Patch(':id')
  updateProfile(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGroupDto,
  ): Promise<void> {
    return this.groups.updateProfile(req.user.userId, id, dto);
  }

  @Put(':id/announcement')
  setAnnouncement(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAnnouncementDto,
  ): Promise<void> {
    return this.groups.setAnnouncement(req.user.userId, id, dto.content);
  }

  @Put(':id/mute')
  setMuteAll(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMuteDto,
  ): Promise<void> {
    return this.groups.setMuteAll(req.user.userId, id, dto.muteAll);
  }

  @Post(':id/members')
  @HttpCode(201)
  invite(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: InviteMembersDto,
  ): Promise<void> {
    return this.groups.invite(req.user.userId, id, dto.userIds);
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  kick(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<void> {
    return this.groups.kick(req.user.userId, id, userId);
  }

  @Post(':id/members/:userId/transfer')
  transfer(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<void> {
    return this.groups.transfer(req.user.userId, id, userId);
  }

  @Post(':id/leave')
  @HttpCode(204)
  async leave(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.groups.leave(req.user.userId, id);
  }
}
