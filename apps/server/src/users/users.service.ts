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

/** 搜索结果单次最多返回条数 */
const SEARCH_RESULT_LIMIT = 20;
/** 昵称模糊搜索时扫描的用户上限（当前规模下内存过滤；数据量大后换 raw ILIKE + pg_trgm） */
const SEARCH_SCAN_LIMIT = 500;

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

  /**
   * 搜索用户：邮箱精确命中优先，其余按昵称不区分大小写子串匹配。
   * 永不返回自己；不含任何关系信息（是否好友由客户端结合 /friends 判断）。
   */
  async search(q: string, meId: number): Promise<PublicUser[]> {
    const term = q.trim().toLowerCase();
    if (!term) return [];

    const results: PublicUser[] = [];
    const seen = new Set<number>([meId]);

    // 邮箱精确命中（加好友最常见路径）——注册时邮箱已统一小写
    const byEmail = await this.prisma.orm.public.User.first({ email: term });
    if (byEmail) {
      results.push(toPublicUser(byEmail));
      seen.add(byEmail.id);
    }

    // 昵称模糊：ORM where 只支持等值，小规模内存过滤（见 SEARCH_SCAN_LIMIT 注释）
    if (results.length < SEARCH_RESULT_LIMIT) {
      const scan = await this.prisma.orm.public.User
        .select('id', 'email', 'nickname', 'avatarUrl', 'createdAt')
        .limit(SEARCH_SCAN_LIMIT)
        .all();
      for (const row of scan) {
        if (results.length >= SEARCH_RESULT_LIMIT) break;
        if (seen.has(row.id)) continue;
        if (!row.nickname.toLowerCase().includes(term)) continue;
        results.push(toPublicUser(row));
        seen.add(row.id);
      }
    }

    return results;
  }
}
