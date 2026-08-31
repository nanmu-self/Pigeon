/**
 * 对象存储 API(/storage/*)。
 *
 * 两条取票路径：
 *  - uploadToken：per-file 票（scope 定向 key），供头像等需要强校验的场景；
 *  - sessionToken：目录级会话票（scope=bucket + insertOnly，可复用），供
 *    chat / file 目录；客户端在 $lib/upload/session.ts 缓存并懒刷新。
 */
import type {
  UploadSessionTicket,
  UploadTicket,
  UploadTokenInput,
} from '@pigeon/shared-types';
import { http } from './http';

export const storageApi = {
  /** 获取一次七牛直传凭证（scope 已定向到服务端生成的 key） */
  uploadToken: (data: UploadTokenInput = {}) =>
    http.Post<UploadTicket>('/storage/upload-token', data),

  /** 获取目录级会话凭证（dir 仅限 chat/file），同一凭证有效期内可复用 */
  sessionToken: (dir: 'chat' | 'file' = 'file') =>
    http.Get<UploadSessionTicket>('/storage/session-token', { params: { dir } }),
};
