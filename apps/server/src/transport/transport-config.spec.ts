import { describe, expect, it } from 'vitest';
import { TransportController } from './transport.controller.js';
import { TransportCertService } from './transport-cert.service.js';
import { resetTransportSettingsCache, resolveTransportSettings } from './config.js';

/**
 * 传输配置（WebTransport 是唯一实时通道，P4 起 Socket.IO 已删）：
 *  - 4 个关键环境变量缺一 → resolveTransportSettings fail-fast（双进程密钥一致性防线）；
 *  - Rust 不可达（cert 拿不到）→ /transport/config 503，不再降级 socket。
 */

function clearEnv(): void {
  delete process.env.JWT_SECRET;
  delete process.env.TRANSPORT_INTERNAL_URL;
  delete process.env.WT_PUBLIC_URL;
  delete process.env.WT_INTERNAL_TOKEN;
  delete process.env.RT_MIN_CLIENT_PROTO;
  resetTransportSettingsCache();
}

function setEnv(): void {
  process.env.JWT_SECRET = 'wt-mode-secret-0123456789';
  process.env.TRANSPORT_INTERNAL_URL = 'http://127.0.0.1:3901/';
  process.env.WT_PUBLIC_URL = 'https://example.com:4433/wt';
  process.env.WT_INTERNAL_TOKEN = 'wt-internal-token-0123456789';
  resetTransportSettingsCache();
}

describe('resolveTransportSettings（fail-fast 与解析）', () => {
  it('缺关键环境变量 → 抛错并指出缺失项', () => {
    clearEnv();
    expect(() => resolveTransportSettings()).toThrow(/JWT_SECRET/);

    clearEnv();
    process.env.JWT_SECRET = 'wt-mode-secret-0123456789';
    resetTransportSettingsCache();
    expect(() => resolveTransportSettings()).toThrow(/TRANSPORT_INTERNAL_URL/);
  });

  it('配置齐全 → 解析成功（internalUrl 去尾斜杠）', () => {
    setEnv();
    const settings = resolveTransportSettings();
    expect(settings.internalUrl).toBe('http://127.0.0.1:3901');
    expect(settings.publicUrl).toBe('https://example.com:4433/wt');
    expect(settings.internalToken).toBe('wt-internal-token-0123456789');
    expect(settings.minClientProto).toBe(1);
  });

  it('进程内缓存：不 reset 则重复读取同一份（改 env 需重启进程才生效）', () => {
    setEnv();
    const s1 = resolveTransportSettings();
    process.env.WT_PUBLIC_URL = 'https://changed.example.com:4433/wt';
    expect(resolveTransportSettings()).toBe(s1);
    expect(s1.publicUrl).toBe('https://example.com:4433/wt');
  });

  it('RT_MIN_CLIENT_PROTO 非法 → 回落 1', () => {
    setEnv();
    process.env.RT_MIN_CLIENT_PROTO = 'abc';
    resetTransportSettingsCache();
    expect(resolveTransportSettings().minClientProto).toBe(1);
    delete process.env.RT_MIN_CLIENT_PROTO;
    resetTransportSettingsCache();
  });
});

describe('TransportController.config（Rust 不可达 → 503）', () => {
  it('cert 不可得 → 503 HttpException', async () => {
    setEnv();
    const controller = new TransportController({
      getCert: async () => null,
    } as unknown as TransportCertService);
    await expect(controller.config()).rejects.toMatchObject({
      status: 503,
    });
  });

  it('cert 正常 → 返回 wt 配置', async () => {
    setEnv();
    const controller = new TransportController({
      getCert: async () => ({ certSha256: ['abc123'], notAfterMs: 0 }),
    } as unknown as TransportCertService);
    await expect(controller.config()).resolves.toEqual({
      transport: 'wt',
      url: 'https://example.com:4433/wt',
      certSha256: ['abc123'],
      minClientProto: 1,
    });
  });
});
