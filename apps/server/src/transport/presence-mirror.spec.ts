import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PresenceMirrorService } from './presence-mirror.service.js';
import { assertInternalAccess, ipInCidr, resetTransportSettingsCache } from './config.js';

/**
 * presence 镜像（D6）语义：
 *   epoch 变化 → 重建；seq 乱序/重复丢弃；正常 delta 更新 + 广播语义。
 * 这里直接驱动 applyDelta（不落网络）；snapshot 拉取用 fetch stub 模拟不可达
 * （applyDelta 内部会异步拉快照，stub 掉避免真实网络尝试）。
 */

const EPOCH_A = '1750000000000-aaaa';
const EPOCH_B = '1760000000000-bbbb';

describe('PresenceMirrorService (D6)', () => {
  beforeAll(() => {
    // resolveTransportSettings 无条件 fail-fast：单测也要备齐传输配置
    process.env.JWT_SECRET = 'test-secret-0123456789abcdef';
    process.env.TRANSPORT_INTERNAL_URL = 'http://127.0.0.1:3901';
    process.env.WT_PUBLIC_URL = 'https://example.com:4433/wt';
    process.env.WT_INTERNAL_TOKEN = 'test-internal-0123456789abcdef';
    resetTransportSettingsCache();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connection refused'))));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    resetTransportSettingsCache();
  });

  it('正常 delta：首连/末路更新镜像，乱序与重复被丢弃', () => {
    const mirror = new PresenceMirrorService();
    // 模拟 Rust 已推过一个初始 delta（seq=5）
    expect(mirror.applyDelta({ epoch: EPOCH_A, seq: 5, userId: '1', online: true })).toBe('applied');
    expect(mirror.isOnline('1')).toBe(true);

    // 正常推进
    expect(mirror.applyDelta({ epoch: EPOCH_A, seq: 6, userId: '1', online: false })).toBe('applied');
    expect(mirror.isOnline('1')).toBe(false);

    // 重复/乱序（seq <= lastSeq）→ 丢弃
    expect(mirror.applyDelta({ epoch: EPOCH_A, seq: 6, userId: '1', online: true })).toBe('stale');
    expect(mirror.applyDelta({ epoch: EPOCH_A, seq: 3, userId: '2', online: true })).toBe('stale');
    expect(mirror.isOnline('1')).toBe(false);
    expect(mirror.isOnline('2')).toBe(false);
  });

  it('epoch 变化（Rust 重启）→ 丢弃 delta 并重建镜像，不留幽灵用户', () => {
    const mirror = new PresenceMirrorService();
    mirror.applyDelta({ epoch: EPOCH_A, seq: 1, userId: '1', online: true });
    mirror.applyDelta({ epoch: EPOCH_A, seq: 2, userId: '2', online: true });
    expect(mirror.size).toBe(2);

    const applied = mirror.applyDelta({ epoch: EPOCH_B, seq: 1, userId: '3', online: true });
    expect(applied).toBe('epoch-reset');
    // epoch 已重置（快照异步重建中）；旧镜像里的幽灵用户在重建时被整体替换
    expect(mirror.currentEpoch).toBeNull();

    // 重建完成前到达的新 epoch delta 被采纳（避免全量 stale）
    const after = mirror.applyDelta({ epoch: EPOCH_B, seq: 2, userId: '4', online: true });
    expect(after).toBe('applied');
    expect(mirror.isOnline('4')).toBe(true);
  });

  it('transport 不可达 → refreshSnapshot 返回 false 并保留现有镜像', async () => {
    const mirror = new PresenceMirrorService();
    mirror.applyDelta({ epoch: EPOCH_A, seq: 1, userId: '1', online: true });
    await expect(mirror.refreshSnapshot()).resolves.toBe(false);
    expect(mirror.isOnline('1')).toBe(true); // 不清空：清空会造成大面积「假离线」
  });
});

describe('assertInternalAccess（§6.5 第 2 层）', () => {
  afterEach?.(() => {
    delete process.env.WT_INTERNAL_TOKEN;
    delete process.env.INTERNAL_ALLOWED_CIDRS;
    resetTransportSettingsCache();
  });

  it('未配置令牌时整体 fail-closed', () => {
    delete process.env.WT_INTERNAL_TOKEN;
    expect(assertInternalAccess({ 'x-internal-token': 'anything' }, '10.0.0.1')).toBe(false);
  });

  it('令牌不匹配拒绝，匹配放行', () => {
    process.env.WT_INTERNAL_TOKEN = 'secret-token-0123456789abcdef';
    expect(assertInternalAccess({}, '10.0.0.1')).toBe(false);
    expect(assertInternalAccess({ 'x-internal-token': 'wrong' }, '10.0.0.1')).toBe(false);
    expect(assertInternalAccess({ 'x-internal-token': 'secret-token-0123456789abcdef' }, '10.0.0.1')).toBe(true);
  });

  it('配置网段后，来源 IP 必须落在网段内', () => {
    process.env.WT_INTERNAL_TOKEN = 'secret-token-0123456789abcdef';
    process.env.INTERNAL_ALLOWED_CIDRS = '172.16.0.0/12,127.0.0.1/32';
    const token = { 'x-internal-token': 'secret-token-0123456789abcdef' };
    expect(assertInternalAccess(token, '172.20.1.5')).toBe(true);
    expect(assertInternalAccess(token, '127.0.0.1')).toBe(true);
    expect(assertInternalAccess(token, '8.8.8.8')).toBe(false);
    expect(assertInternalAccess(token, undefined)).toBe(false);
  });
});

describe('ipInCidr', () => {
  it('IPv4 网段匹配', () => {
    expect(ipInCidr('172.16.0.1', '172.16.0.0/12')).toBe(true);
    expect(ipInCidr('172.31.255.255', '172.16.0.0/12')).toBe(true);
    expect(ipInCidr('172.32.0.0', '172.16.0.0/12')).toBe(false);
    expect(ipInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('192.168.1.7', '192.168.1.7/32')).toBe(true);
    expect(ipInCidr('any', 'bad-input')).toBe(false);
  });

  it('IPv6 仅精确匹配（当前部署不涉及）', () => {
    expect(ipInCidr('::1', '::1')).toBe(true);
    expect(ipInCidr('::2', '::1')).toBe(false);
  });
});
