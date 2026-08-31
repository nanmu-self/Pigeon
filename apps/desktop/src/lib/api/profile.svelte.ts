/**
 * 当前登录用户资料 — Svelte 5 runes 全局状态（.svelte.ts 模块单例）。
 *
 * 生命周期：
 *  - 登录成功后由登录页 profile.set(user) 立即写入（省一次请求）；
 *  - 直接进入登录后页面时由布局 onMount 调 load() 兜底拉取；
 *  - 设置页保存资料后调 set() 同步，侧边栏头像即时更新。
 */
import type { PublicUser } from '@pigeon/shared-types';
import { tokenStore } from './http';
import { usersApi } from './users';

class ProfileStore {
  user = $state<PublicUser | null>(null);

  /** 侧边栏/设置页用的头像地址（未设置时空串） */
  get avatarUrl(): string {
    return this.user?.avatarUrl ?? '';
  }

  /** 展示名：昵称，兜底邮箱前缀，再兜底 "ME" */
  get displayName(): string {
    return this.user?.nickname || this.user?.email.split('@')[0] || 'ME';
  }

  /** 拉取当前用户资料；未登录/token 失效时静默失败（由登录流程接管） */
  async load(): Promise<void> {
    if (!tokenStore.get() || this.user) return;
    try {
      this.user = await usersApi.me();
    } catch {
      /* 401 等：不弹错误，页面按未登录态降级 */
    }
  }

  set(user: PublicUser | null): void {
    this.user = user;
  }
}

export const profile = new ProfileStore();
