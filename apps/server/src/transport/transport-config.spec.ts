import { describe, expect, it } from 'vitest';
import { EventsGateway } from '../ws/events.gateway.js';
import { WsEventsService } from '../ws/ws-events.service.js';
import { TransportBridgeService } from './transport-bridge.service.js';
import { resetTransportSettingsCache, resolveTransportSettings } from './config.js';
import { WsModule } from '../ws/ws.module.js';

/**
 * RT_TRANSPORT 开关装配（决策 D5）：
 *  - socket（默认）→ 旧 WsEventsService + EventsGateway；
 *  - wt → useExisting: TransportBridgeService（网关不挂载）+ 缺配置启动即抛（fail-fast）。
 */

function clearEnv(): void {
  delete process.env.RT_TRANSPORT;
  delete process.env.JWT_SECRET;
  delete process.env.TRANSPORT_INTERNAL_URL;
  delete process.env.WT_PUBLIC_URL;
  delete process.env.WT_INTERNAL_TOKEN;
  resetTransportSettingsCache();
}

describe('WsModule.register()（RT_TRANSPORT 开关）', () => {
  it('默认（socket）：挂载网关，WsEventsService 即旧实现', () => {
    clearEnv();
    const dm = WsModule.register();
    expect(dm.providers).toContain(WsEventsService);
    expect(dm.providers).toContain(EventsGateway);
  });

  it('wt：WsEventsService 指向 TransportBridgeService，网关不挂载', () => {
    clearEnv();
    process.env.RT_TRANSPORT = 'wt';
    process.env.JWT_SECRET = 'wt-mode-secret-0123456789';
    process.env.TRANSPORT_INTERNAL_URL = 'http://127.0.0.1:3901';
    process.env.WT_PUBLIC_URL = 'https://example.com:4433/wt';
    process.env.WT_INTERNAL_TOKEN = 'wt-internal-token-0123456789';
    resetTransportSettingsCache();

    const dm = WsModule.register();
    expect(dm.exports).toContain(WsEventsService);
    const bridgeProvider = dm.providers?.find(
      (p) => typeof p === 'object' && p !== null && 'provide' in p,
    ) as { provide: unknown; useExisting: unknown } | undefined;
    expect(bridgeProvider?.provide).toBe(WsEventsService);
    expect(bridgeProvider?.useExisting).toBe(TransportBridgeService);
    expect(dm.providers).not.toContain(EventsGateway);
  });

  it('wt 缺配置 → 启动即抛（fail-fast，双进程密钥一致性防线）', () => {
    clearEnv();
    process.env.RT_TRANSPORT = 'wt';
    resetTransportSettingsCache();
    expect(() => WsModule.register()).toThrow(/JWT_SECRET/);

    clearEnv();
    process.env.RT_TRANSPORT = 'wt';
    process.env.JWT_SECRET = 'wt-mode-secret-0123456789';
    resetTransportSettingsCache();
    expect(() => WsModule.register()).toThrow(/TRANSPORT_INTERNAL_URL/);
  });

  it('settings 解析：默认值与缓存', () => {
    clearEnv();
    const s1 = resolveTransportSettings();
    expect(s1.mode).toBe('socket');
    expect(s1.internalUrl).toBe('http://127.0.0.1:3901');
    expect(s1.minClientProto).toBe(1);
    process.env.RT_TRANSPORT = 'wt'; // 不重启（不 reset）不生效 —— 与「改值需重启」语义一致
    expect(resolveTransportSettings().mode).toBe('socket');
  });
});
