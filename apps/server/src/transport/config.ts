/**
 * 实时传输层配置（RT_TRANSPORT 开关，决策 D5）。
 *
 * RT_TRANSPORT 同时决定：
 *  - WsModule 装配哪个 bridge（旧 Socket.IO 桥 / 新 HTTP 桥）与网关是否挂载；
 *  - GET /transport/config 下发给客户端的 transport 字段（灰度权威开关）。
 *
 * ⚠️ RT_TRANSPORT=wt 时必须显式配置 JWT_SECRET（Nest 未配置时会随机生成，
 * 与 Rust 验签密钥必然不同 → 「能连上但 hello 全部 auth_failed」），
 * 以及 TRANSPORT_INTERNAL_URL / WT_PUBLIC_URL / WT_INTERNAL_TOKEN，缺一启动失败（fail-fast）。
 */

export type TransportMode = 'socket' | 'wt';

export interface TransportSettings {
  mode: TransportMode;
  /** Rust 传输服务 internal HTTP 基址（如 http://pigeon-transport:3901） */
  internalUrl: string;
  /** 下发给客户端的 WT 公网地址（如 https://example.com:4433/wt） */
  publicUrl: string;
  /** 内部 API 共享令牌（与 Rust 的 WT_INTERNAL_TOKEN 一致） */
  internalToken: string;
  /** 最低客户端协议版本 */
  minClientProto: number;
  /** Rust /internal/cert 缓存上限（轮换窗口期指纹会变，禁长缓存） */
  certCacheTtlMs: number;
}

let cached: TransportSettings | null = null;

/** 解析并缓存设置（进程内只解析一次；缺关键项 fail-fast） */
export function resolveTransportSettings(): TransportSettings {
  if (cached) return cached;

  const mode = (process.env.RT_TRANSPORT ?? 'socket') as TransportMode;
  if (mode !== 'socket' && mode !== 'wt') {
    throw new Error(`RT_TRANSPORT 非法：${mode}（只支持 socket | wt）`);
  }

  const minClientProto = Number(process.env.RT_MIN_CLIENT_PROTO ?? 1);

  if (mode === 'wt') {
    const missing = [
      process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16 ? null : 'JWT_SECRET（≥16 字节，必须与 Rust 完全一致，否则验签 100% 失败）',
      process.env.TRANSPORT_INTERNAL_URL ? null : 'TRANSPORT_INTERNAL_URL（如 http://pigeon-transport:3901）',
      process.env.WT_PUBLIC_URL ? null : 'WT_PUBLIC_URL（如 https://example.com:4433/wt）',
      process.env.WT_INTERNAL_TOKEN ? null : 'WT_INTERNAL_TOKEN（与 Rust 一致的长随机串）',
    ].filter((v): v is string => v !== null);
    if (missing.length > 0) {
      throw new Error(`RT_TRANSPORT=wt 缺少必填环境变量：\n  - ${missing.join('\n  - ')}`);
    }
  }

  cached = {
    mode,
    internalUrl: (process.env.TRANSPORT_INTERNAL_URL ?? 'http://127.0.0.1:3901').replace(/\/+$/, ''),
    publicUrl: process.env.WT_PUBLIC_URL ?? '',
    internalToken: process.env.WT_INTERNAL_TOKEN ?? '',
    minClientProto: Number.isFinite(minClientProto) && minClientProto > 0 ? minClientProto : 1,
    certCacheTtlMs: 30_000,
  };
  return cached;
}

/** 供测试重置（仅测试路径使用） */
export function resetTransportSettingsCache(): void {
  cached = null;
}

/**
 * 内部 API 防线（§6.5 第 2 层）：
 * 校验 x-internal-token（长随机、与 JWT_SECRET 不同源）；
 * INTERNAL_ALLOWED_CIDRS 配置时追加来源 IP 网段校验
 * （生产 compose 网络设为容器网段，如 172.16.0.0/12；未配置则跳过 IP 校验）。
 */
export function assertInternalAccess(headers: Record<string, string | undefined>, remoteIp: string | undefined): boolean {
  const expected = process.env.WT_INTERNAL_TOKEN;
  if (!expected) return false; // 未配置令牌 = 内部端点整体不可用（fail-closed）
  const provided = headers['x-internal-token'];
  if (provided !== expected) return false;

  const cidrs = (process.env.INTERNAL_ALLOWED_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (cidrs.length === 0) return true; // 未配置网段限制（本地开发/e2e）
  if (!remoteIp) return false;
  return cidrs.some((cidr) => ipInCidr(remoteIp, cidr));
}

/** 最小 CIDR 匹配（IPv4 完整支持；IPv6 仅精确匹配） */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  if (ip.includes(':') || range.includes(':')) return ip === range; // IPv6：精确匹配
  const bits = Number(bitsRaw ?? 32);
  const toInt = (v: string): number | null => {
    const parts = v.split('.');
    if (parts.length !== 4) return null;
    let out = 0;
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      out = (out << 8) | n;
    }
    return out >>> 0;
  };
  const ipInt = toInt(ip);
  const rangeInt = toInt(range);
  if (ipInt === null || rangeInt === null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}
