/**
 * 用户资料 API(/users/*)。全部接口需要登录（JWT）。
 */
import type { PublicUser, UpdateProfileInput } from '@pigeon/shared-types';
import { http } from './http';

export const usersApi = {
  /** 当前登录用户资料（含头像外链） */
  me: () => http.Get<PublicUser>('/users/me'),
  /** 部分更新当前用户资料（昵称 / 头像外链），返回更新后的完整资料 */
  updateMe: (data: UpdateProfileInput) => http.Patch<PublicUser>('/users/me', data),
  /** 搜索用户（邮箱精确 + 昵称模糊），用于加好友 */
  search: (q: string) => http.Get<PublicUser[]>(`/users/search?q=${encodeURIComponent(q)}`),
};
