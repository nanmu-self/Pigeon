import { createHmac, randomUUID } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type {
  UploadDir,
  UploadSessionTicket,
  UploadTicket,
  UploadTokenInput,
} from '@pigeon/shared-types';
import { resolveQiniuConfig, type QiniuEnvConfig } from './config.js';

/** 会话凭证适用的目录（头像必须走 per-file 票强校验类型/大小） */
export type SessionDir = Exclude<UploadDir, 'avatar'>;

/** 各上传目录的限制（fsizeLimit 单位：字节；mimeLimit 语法见七牛上传策略文档） */
const DIR_LIMITS: Record<UploadDir, { mimeLimit?: string; fsizeLimit: number }> = {
  /** 头像：只允许常见图片格式，5 MB */
  avatar: {
    mimeLimit: 'image/jpeg;image/png;image/webp;image/gif',
    fsizeLimit: 5 * 1024 * 1024,
  },
  /** 聊天媒体：不限类型（由前端另行约束），100 MB */
  chat: { fsizeLimit: 100 * 1024 * 1024 },
  /** 普通文件：不限类型，200 MB（> 4 MB 时 qiniu-js 自动走分片上传） */
  file: { fsizeLimit: 200 * 1024 * 1024 },
};

/** 上传成功后七牛同步返回给前端的字段（complete 回调的 res） */
const RETURN_BODY = '{"key":"$(key)","hash":"$(etag)","fsize":$(fsize),"mime":"$(mime)","fname":"$(fname)"}';

/**
 * urlsafe base64（七牛规范：仅替换 + → - 与 / → _，保留 = padding）。
 * 必须与官方 SDK 行为一致（Go base64.URLEncoding / Python urlsafe_b64encode /
 * Node qiniu sdk 均保留 padding）——剥掉 padding 会导致七牛侧解码失败，
 * 直传时返回 401 {"error":"bad token","error_code":"BadToken"}。
 */
function urlsafeBase64(input: string | Buffer): string {
  const b64 = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return b64.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/** 从原始文件名推断受控扩展名（小写、仅字母数字、≤ 8 位），不可信则留空 */
function extFromFileName(fileName?: string): string {
  if (!fileName) return '';
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return '';
  const ext = fileName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? `.${ext}` : '';
}

/**
 * 七牛上传凭证（Upload Token）颁发服务。
 *
 * 签名算法（官方「上传凭证」规范）：
 *   encodedPutPolicy = urlsafe_base64(utf8(putPolicy JSON))
 *   sign             = urlsafe_base64(hmac_sha1(encodedPutPolicy, SecretKey))
 *   token            = `${AccessKey}:${sign}:${encodedPutPolicy}`
 *
 * 安全要点：
 *  - SecretKey 只存在于服务端，前端永远拿不到；
 *  - scope 定向到 `bucket:key`（key 由服务端生成），客户端无法覆盖任意文件；
 *  - insertOnly 进一步禁止覆盖已存在的对象；
 *  - mimeLimit / fsizeLimit 按目录收口，防御性限制放在七牛侧强制执行。
 */
@Injectable()
export class QiniuStorageService {
  private readonly cfg: QiniuEnvConfig | null = resolveQiniuConfig();

  issueTicket(dto: UploadTokenInput): UploadTicket {
    if (!this.cfg) {
      throw new ServiceUnavailableException(
        '对象存储未配置：请在服务端 .env 设置 QINIU_ACCESS_KEY / QINIU_SECRET_KEY / QINIU_BUCKET / QINIU_DOMAIN',
      );
    }
    const cfg = this.cfg;
    const dir = dto.dir ?? 'file';
    const limits = DIR_LIMITS[dir];
    const key = this.makeKey(dir, dto.fileName);
    const deadline = Math.floor(Date.now() / 1000) + cfg.tokenTtl;

    const putPolicy: Record<string, unknown> = {
      scope: `${cfg.bucket}:${key}`,
      deadline,
      insertOnly: 1,
      fsizeLimit: limits.fsizeLimit,
      returnBody: RETURN_BODY,
    };
    if (limits.mimeLimit) putPolicy.mimeLimit = limits.mimeLimit;

    const encodedPolicy = urlsafeBase64(JSON.stringify(putPolicy));
    const hmac = createHmac('sha1', cfg.secretKey);
    hmac.update(encodedPolicy, 'utf8');
    const encodedSign = urlsafeBase64(hmac.digest());
    const token = `${cfg.accessKey}:${encodedSign}:${encodedPolicy}`;

    return {
      token,
      key,
      region: cfg.region,
      domain: cfg.domain,
      publicUrl: `${cfg.domain}/${key}`,
      expiresAt: deadline,
      maxSize: limits.fsizeLimit,
    };
  }

  /** 生成资源名：pigeon/{目录}/{年月}/{uuid}{扩展名}，避免同名覆盖与路径穿越 */
  private makeKey(dir: UploadDir, fileName?: string): string {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return `pigeon/${dir}/${ym}/${randomUUID()}${extFromFileName(fileName)}`;
  }

  /**
   * 目录级会话凭证（仅 chat / file，头像仍走 issueTicket 强校验类型/大小）。
   *
   * 与 per-file 票的区别：scope 为整个 bucket（不限 key），同一凭证在有效期内
   * 可复用于该目录的多个文件，客户端按 `{dir}/{年月}/{uuid}.{净化ext}` 规则
   * 自行生成 key。insertOnly 仍禁止覆盖已有对象；fsizeLimit 沿用目录限制，
   * 七牛侧强校验大小。chat 目录的 key 以 `chat/` 为前缀，配合七牛空间配置的
   * 生命周期规则（前缀 chat）实现聊天媒体自动清理。
   */
  issueSessionTicket(dir: SessionDir): UploadSessionTicket {
    if (!this.cfg) {
      throw new ServiceUnavailableException(
        '对象存储未配置：请在服务端 .env 设置 QINIU_ACCESS_KEY / QINIU_SECRET_KEY / QINIU_BUCKET / QINIU_DOMAIN',
      );
    }
    const cfg = this.cfg;
    const limits = DIR_LIMITS[dir];
    const deadline = Math.floor(Date.now() / 1000) + cfg.tokenTtl;

    const putPolicy: Record<string, unknown> = {
      scope: cfg.bucket,
      deadline,
      insertOnly: 1,
      fsizeLimit: limits.fsizeLimit,
      returnBody: RETURN_BODY,
    };

    const encodedPolicy = urlsafeBase64(JSON.stringify(putPolicy));
    const hmac = createHmac('sha1', cfg.secretKey);
    hmac.update(encodedPolicy, 'utf8');
    const encodedSign = urlsafeBase64(hmac.digest());

    return {
      token: `${cfg.accessKey}:${encodedSign}:${encodedPolicy}`,
      domain: cfg.domain,
      region: cfg.region,
      expiresAt: deadline,
      maxSize: limits.fsizeLimit,
    };
  }
}
