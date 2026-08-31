import { Body, Controller, Get, HttpCode, Inject, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { PublicUser } from '@pigeon/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { UpdateProfileDto } from './dto.js';
import { UsersService } from './users.service.js';

/** 挂载了 JwtPayload 的请求（由 JwtAuthGuard 写入 request.user） */
interface AuthedRequest {
  user: JwtPayload;
}

/**
 * 用户资料接口 — 全部需要登录（JwtAuthGuard）。
 * 资料修改走部分更新语义：PATCH /users/me 只校验并写入出现的字段。
 */
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    // swc 编译无装饰器元数据，注入一律显式 @Inject（与全仓库约定一致）
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  /** 当前登录用户资料（含头像外链） */
  @Get('me')
  me(@Req() req: AuthedRequest): Promise<PublicUser> {
    return this.users.me(req.user.userId);
  }

  /** 搜索用户（邮箱精确 + 昵称模糊），用于加好友 */
  @Get('search')
  search(@Req() req: AuthedRequest, @Query('q') q: string): Promise<PublicUser[]> {
    return this.users.search(q ?? '', req.user.userId);
  }

  /** 更新当前用户资料（昵称 / 头像外链），返回更新后的完整资料 */
  @Patch('me')
  @HttpCode(200)
  updateMe(@Req() req: AuthedRequest, @Body() dto: UpdateProfileDto): Promise<PublicUser> {
    return this.users.updateMe(req.user.userId, dto);
  }
}
