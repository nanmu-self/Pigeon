/**
 * 七牛直传封装 — qiniu-js@2.x 的高层用法。
 *
 * 用法：
 *   const handle = uploadToQiniu(file, {
 *     dir: 'chat',
 *     onProgress: (p) => console.log(`${p.percent}%`),
 *   });
 *   const res = await handle.done;      // { key, url, hash, ... }
 *   handle.cancel();                    // 随时取消（进行中的分片请求会被中断）
 *
 * 两条取票路径（对调用方透明）：
 *  - avatar → per-file 票（POST /storage/upload-token，scope 定向服务端生成的
 *    key，服务端强校验图片类型与 5MB 上限）；
 *  - chat / file → 目录级会话票（GET /storage/session-token，scope=bucket +
 *    insertOnly，可复用），key 由客户端按 `{dir}/{年月}/{uuid}.{净化ext}` 生成；
 *    token 缓存在 $lib/upload/session.ts，剩余 < 10 分钟时在开始上传前懒刷新；
 *    上传中万一 401，刷新 token 后用同一 key 重试（断点续传接着传）。
 *
 * chat 目录 key 前缀为 `chat/`，配合七牛空间配置的生命周期规则（前缀 chat）
 * 实现聊天媒体自动清理；file 为 `file/`，avatar 为 `pigeon/avatar/`（永久）。
 */
import * as qiniu from 'qiniu-js';
import type { UploadDir } from '@pigeon/shared-types';
import { storageApi } from '$lib/api/storage';
import {
  getSessionToken,
  invalidateSessionToken,
  type SessionDir,
} from './session';

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface UploadResult {
  /** 资源名（per-file 票 = 服务端生成；会话票 = 客户端生成） */
  key: string;
  /** 最终访问地址（domain + key） */
  url: string;
  /** 七牛 etag */
  hash: string;
  size?: number;
  mime?: string;
  fname?: string;
}

export interface UploadHandle {
  /** 上传完成 resolve / 失败或取消 reject */
  done: Promise<UploadResult>;
  /** 取消上传（对已完成的上传调用是无操作） */
  cancel(): void;
}

export interface UploadOptions {
  /** 上传目录：avatar 走 per-file 票；chat/file 走可复用的会话票 */
  dir?: UploadDir;
  /** 原始文件名，缺省取 file.name（供扩展名推断） */
  fileName?: string;
  /** 上传进度回调（percent: 0~100） */
  onProgress?: (progress: UploadProgress) => void;
}

export class QiniuUploadError extends Error {
  /** 七牛错误码（如 401 token 无效/过期、614 文件已存在、413 大小超限） */
  code?: number;
  reqId?: string;

  constructor(message: string, code?: number, reqId?: string) {
    super(message);
    this.name = 'QiniuUploadError';
    this.code = code;
    this.reqId = reqId;
  }
}

/** 上传被用户取消 */
export class UploadCanceledError extends Error {
  constructor() {
    super('上传已取消');
    this.name = 'UploadCanceledError';
  }
}

/** 会话票 key 规则：{dir}/{年月}/{uuid}.{净化ext}（与生命周期规则前缀对齐） */
function buildSessionKey(dir: SessionDir, fileName?: string): string {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${dir}/${ym}/${randomUuid()}${extFromFileName(fileName)}`;
}

/** 与服务端 extFromFileName 相同的净化规则（小写、仅字母数字、≤ 8 位） */
function extFromFileName(fileName?: string): string {
  if (!fileName) return '';
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return '';
  const ext = fileName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? `.${ext}` : '';
}

/** randomUUID 优先，非安全上下文兜底用 getRandomValues 拼 v4 */
function randomUuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uploadToQiniu(file: Blob, options: UploadOptions = {}): UploadHandle {
  const fileName = options.fileName ?? (file instanceof File ? file.name : undefined);

  let settled = false;
  let subscription: { unsubscribe(): void } | null = null;
  let rejectOuter!: (err: Error) => void;

  const done = new Promise<UploadResult>((resolve, reject) => {
    rejectOuter = reject;

    // 单次直传：token + key 就绪后发起，出错时 reject（调用方决定是否重试）
    function runOnce(token: string, region: string, key: string, url: string): Promise<UploadResult> {
      return new Promise<UploadResult>((resolve, reject) => {
        const regionCode = (qiniu.region as Record<string, string | undefined>)[region];
        const observable = qiniu.upload(
          file,
          key,
          token,
          { fname: fileName },
          { useCdnDomain: true, ...(regionCode ? { region: regionCode } : {}) },
        );

        subscription = observable.subscribe({
          next: (res) => {
            if (!settled) options.onProgress?.(res.total);
          },
          error: (err) => {
            if (settled) return;
            reject(new QiniuUploadError(err.message || '上传失败', err.code, err.reqId));
          },
          complete: (res) => {
            if (settled) return;
            options.onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
            resolve({
              key: res.key,
              url,
              hash: res.hash,
              size: res.fsize,
              mime: res.mime,
              fname: res.fname,
            });
          },
        });

        // 取票后用户立刻取消的竞态：订阅号刚建立就退订
        if (settled) subscription.unsubscribe();
      });
    }

    function finish(res: UploadResult) {
      if (settled) return;
      settled = true;
      resolve(res);
    }

    function fail(err: unknown) {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    // avatar：per-file 票（scope 定向 key，服务端强校验类型/大小）
    async function runAvatarUpload(): Promise<void> {
      const ticket = await storageApi.uploadToken({ dir: 'avatar', fileName });
      if (settled) return;
      finish(await runOnce(ticket.token, ticket.region, ticket.key, ticket.publicUrl));
    }

    // chat/file：会话票复用；上传中 401（token 过期/时钟偏差）→ 刷新后同一 key 重试
    async function runSessionUpload(): Promise<void> {
      const dir: SessionDir = options.dir === 'chat' ? 'chat' : 'file';
      const key = buildSessionKey(dir, fileName);

      let state = await getSessionToken(dir);
      if (settled) return;

      let res: UploadResult;
      try {
        res = await runOnce(state.token, state.region, key, `${state.domain}/${key}`);
      } catch (err) {
        if (!(err instanceof QiniuUploadError) || err.code !== 401 || settled) throw err;
        invalidateSessionToken(dir);
        state = await getSessionToken(dir);
        if (settled) return;
        res = await runOnce(state.token, state.region, key, `${state.domain}/${key}`);
      }
      finish(res);
    }

    void (options.dir === 'avatar' ? runAvatarUpload() : runSessionUpload()).catch(fail);
  });

  return {
    done,
    cancel() {
      if (settled) return;
      settled = true;
      subscription?.unsubscribe();
      subscription = null;
      rejectOuter(new UploadCanceledError());
    },
  };
}

/** 便于调用方判断是否为用户主动取消（通常静默处理，不弹错误） */
export function isUploadCanceled(err: unknown): boolean {
  return err instanceof UploadCanceledError;
}

export type { UploadDir };
