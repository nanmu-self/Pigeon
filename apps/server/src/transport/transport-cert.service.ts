import { Injectable, Logger } from '@nestjs/common';
import { resolveTransportSettings } from './config.js';

/** GET /internal/cert 的响应（Rust 侧） */
export interface TransportCertInfo {
  /** SHA-256(DER) 指纹，base64；轮换窗口期新旧并存（数组） */
  certSha256: string[];
  /** 最早过期时间（Unix 毫秒；观测/告警用） */
  notAfterMs: number;
}

/**
 * 证书信息代理：客户端（重）连前经 GET /transport/config 间接拿指纹，
 * Nest 侧缓存 ≤ 30s（证书 7 天轮换、14 天有效，30s 缓存足以容忍 QPS；
 * 客户端本身每次连接都重新请求，禁止长缓存 —— 轮换后旧指纹会失效）。
 */
@Injectable()
export class TransportCertService {
  private readonly logger = new Logger(TransportCertService.name);
  private cache: { at: number; value: TransportCertInfo } | null = null;

  async getCert(ttlMs = resolveTransportSettings().certCacheTtlMs): Promise<TransportCertInfo | null> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < ttlMs) return this.cache.value;

    const settings = resolveTransportSettings();
    try {
      const response = await fetch(`${settings.internalUrl}/internal/cert`, {
        headers: { 'x-internal-token': settings.internalToken },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`transport returned ${response.status}`);
      const value = (await response.json()) as TransportCertInfo;
      this.cache = { at: now, value };
      return value;
    } catch (error) {
      this.logger.warn(`获取 transport 证书指纹失败: ${String(error)}`);
      this.cache = null;
      return null;
    }
  }

  /** 测试用 */
  clearCache(): void {
    this.cache = null;
  }
}
