import type { PublicUser } from '@pigeon/shared-types';

/**
 * 用户表行结构（Prisma 查询返回的 User 模型字段）。
 * auth 与 users 模块共用，避免两处映射漂移。
 */
export interface UserRow {
  id: number;
  email: string;
  password: string;
  nickname: string;
  avatarUrl: string | null;
  createdAt: string;
}

/** 映射所需的最小字段集：搜索等场景只取公开列（不含密码哈希）时也能复用 */
export type PublicUserFields = Pick<UserRow, 'id' | 'email' | 'nickname' | 'avatarUrl' | 'createdAt'>;

/** 行 → 对外公开用户信息（不含密码哈希；avatarUrl 为空时响应里不出现该键） */
export function toPublicUser(row: PublicUserFields): PublicUser {
  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname,
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
    createdAt: row.createdAt,
  };
}
