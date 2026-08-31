/**
 * alova 实例 — 普通业务 HTTP 请求统一走这里（与 WS 实时通道互补）。
 *
 * 设计：
 *  - adapterFetch：Tauri webview 原生 fetch，无额外依赖；
 *  - beforeRequest 统一附加 Bearer token（登录落地后由 auth 流程写入 tokenStore）；
 *  - onSuccess 统一做非 2xx → ApiError 转换，业务侧只需 try/catch；
 *  - cacheFor: null —— 默认不缓存（IM 类应用数据实时性优先，按需在单个 Method 上开）。
 */
import { createAlova } from 'alova';
import adapterFetch from 'alova/fetch';
import { SERVER_URL } from './config';

// ── token 存取（占位实现：登录功能落地后替换为安全存储） ──
const TOKEN_KEY = 'pigeon:token';

export const tokenStore = {
  get(): string {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  },
  set(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
  },
};

/** 统一的 API 错误：携带 HTTP 状态码，便于区分 401/403/5xx */
export class ApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export const http = createAlova({
  requestAdapter: adapterFetch(),
  timeout: 10_000,
  cacheFor: null,
  beforeRequest(method) {
    const token = tokenStore.get();
    if (token) method.config.headers.Authorization = `Bearer ${token}`;
  },
  responded: {
    onSuccess: async (response) => {
      if (!response.ok) {
        // 尽力读取后端错误信息（NestJS 默认 { statusCode, message }）
        let message = `HTTP ${response.status}`;
        try {
          const body = (await response.json()) as { message?: string } | null;
          if (body?.message) message = String(body.message);
        } catch {
          /* body 非 JSON 时保留默认文案 */
        }
        // TODO(鉴权): 401 时清理 token 并跳转登录页
        throw new ApiError(message, response.status);
      }
      if (response.status === 204) return null;
      return response.json();
    },
  },
});

// ── 业务 API 声明（示例：探活。后续模块按需在这里集中扩展） ──

export interface ServerHealth {
  status: 'ok';
  /** 当前 Socket.IO 在线连接数 */
  wsOnline: number;
  /** 进程运行秒数 */
  uptime: number;
  /** 服务器 Unix 毫秒时间戳 */
  ts: number;
}

export const serverApi = {
  health: () => http.Get<ServerHealth>('/health'),
};
