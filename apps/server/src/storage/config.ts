/**
 * 七牛云 Kodo 配置解析（环境变量 → 运行时配置）。
 *
 * 必填三项缺失时 resolveQiniuConfig() 返回 null，凭证接口将以 503 提示，
 * 而不是在启动时崩溃——未接入七牛的部署环境仍可正常跑其它功能。
 */
export interface QiniuEnvConfig {
  accessKey: string;
  secretKey: string;
  /** 存储空间名（Bucket） */
  bucket: string;
  /** 空间外链域名（含协议，不含末尾斜杠），用于拼接最终访问 URL */
  domain: string;
  /** 存储区域代号（qiniu-js 2.x 支持集） */
  region: string;
  /** 上传凭证有效期（秒） */
  tokenTtl: number;
}

/** qiniu-js 2.x SDK 支持的区域 */
export const QINIU_REGIONS = ['z0', 'z1', 'z2', 'na0', 'as0'] as const;

export function resolveQiniuConfig(): QiniuEnvConfig | null {
  const accessKey = process.env.QINIU_ACCESS_KEY?.trim() ?? '';
  const secretKey = process.env.QINIU_SECRET_KEY?.trim() ?? '';
  const bucket = process.env.QINIU_BUCKET?.trim() ?? '';
  const domain = process.env.QINIU_DOMAIN?.trim().replace(/\/+$/, '') ?? '';

  if (!accessKey || !secretKey || !bucket || !domain) return null;

  const regionRaw = process.env.QINIU_REGION?.trim() ?? '';
  const region = (QINIU_REGIONS as readonly string[]).includes(regionRaw)
    ? regionRaw
    : 'z0';
  const tokenTtl = clampInt(process.env.QINIU_TOKEN_TTL, 300, 7 * 86400, 3600);

  return { accessKey, secretKey, bucket, domain, region, tokenTtl };
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
