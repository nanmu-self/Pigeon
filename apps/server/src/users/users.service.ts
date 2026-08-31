import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PublicUser } from '@pigeon/shared-types';
import { PrismaService } from '../prisma.service.js';
import { toPublicUser } from './user.mapper.js';
import type { UpdateProfileDto } from './dto.js';

/**
 * 用户资料服务：当前登录用户的读取与部分更新。
 * 只暴露 PublicUser，任何路径都不得返回密码哈希。
 */
@Injectable()
export class UsersService {
  constructor(
    // swc 编译无装饰器元数据，注入一律显式 @Inject（与全仓库约定一致）
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async me(userId: number): Promise<PublicUser> {
    const row = await this.prisma.orm.public.User.first({ id: userId });
    if (!row) throw new NotFoundException('用户不存在');
    return toPublicUser(row);
  }

  /** 部分更新：只写入入参中出现的字段；昵称入库前 trim */
  async updateMe(userId: number, dto: UpdateProfileDto): Promise<PublicUser> {
    const data: { nickname?: string; avatarUrl?: string } = {};
    if (dto.nickname !== undefined) data.nickname = dto.nickname.trim();
    if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('没有需要更新的字段');
    }

    const row = await this.prisma.orm.public.User.where({ id: userId }).update(data);
    if (!row) throw new NotFoundException('用户不存在');
    return toPublicUser(row);
  }
}
