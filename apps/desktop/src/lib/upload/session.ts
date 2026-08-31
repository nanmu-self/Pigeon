/**
 * 会话级直传凭证管理 — chat / file 目录的 token 缓存与懒刷新。
 *
 * 策略：
 *  - 同目录凭证在内存缓存复用，一次会话内连续上传不再逐文件取票；
 *  - 「剩余 < 10 分钟」时在**开始上传前**刷新（上传中不换 token —— 七牛按
 *    分片逐次验签，中途过期会导致后续分片 401）；
 *  - 上传中万一仍然 401（本地时钟偏差等），调用方 invalidateSessionToken()
 *    后用同一 key 重试，断点续传 ctx 会接着传；
 *  - 凭证只存内存，不落 localStorage，登出/刷新页面即失效。
 */
import { storageApi } from '$lib/api/storage';

/** 会话凭证适用的目录（avatar 走 per-file 票，强校验类型/大小） */
export type SessionDir = 'chat' | 'file';

export interface SessionTokenState {
  token: string;
  domain: string;
  region: string;
  /** Unix 秒 */
  expiresAt: number;
  maxSize: number;
}

/** 剩余有效期低于该阈值时，在下一次上传开始前刷新 */
const REFRESH_BEFORE_MS = 10 * 60 * 1000;

const cache = new Map<SessionDir, SessionTokenState>();
const inflight = new Map<SessionDir, Promise<SessionTokenState>>();

/** 取目录会话凭证：缓存剩余充足时直接返回，否则（或并发首次）请求新票 */
export async function getSessionToken(dir: SessionDir): Promise<SessionTokenState> {
  const hit = cache.get(dir);
  if (hit && hit.expiresAt * 1000 - Date.now() > REFRESH_BEFORE_MS) return hit;

  let pending = inflight.get(dir);
  if (!pending) {
    pending = storageApi
      .sessionToken(dir)
      .then((ticket) => {
        cache.set(dir, ticket);
        return ticket;
      })
      .finally(() => inflight.delete(dir));
    inflight.set(dir, pending);
  }
  return pending;
}

/** 作废缓存（401 兜底重试前调用，强制下次取新票） */
export function invalidateSessionToken(dir: SessionDir): void {
  cache.delete(dir);
}
