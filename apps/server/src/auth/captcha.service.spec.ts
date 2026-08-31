import { describe, expect, it, vi } from 'vitest';
import { CaptchaService } from './captcha.service.js';

describe('CaptchaService', () => {
  it('issue 返回 captchaId 与 PNG dataURL,且验证码可通过校验', () => {
    const service = new CaptchaService();
    const { captchaId, image } = service.issue();

    expect(captchaId).toMatch(/^[0-9a-f]{32}$/);
    expect(image).toMatch(/^data:image\/png;base64,/);

    // dataURL 无法反推明文 —— 注入一条已知验证码验证正确路径与归一化
    (service as unknown as { store: Map<string, { code: string; expiresAt: number }> }).store.set(
      'known-id',
      { code: 'XY99', expiresAt: Date.now() + 60_000 },
    );
    expect(service.verify('known-id', ' xy99 ')).toBe(true);
  });

  it('忽略大小写与首尾空白;验证后立即作废(一次性)', () => {
    const service = new CaptchaService();
    const { image } = service.issue();
    expect(image).toBeTruthy();

    // 错误码 → false,且该 captchaId 也被消费(一次性)
    const challenge = service.issue();
    expect(service.verify(challenge.captchaId, 'WRONG')).toBe(false);
    expect(service.verify(challenge.captchaId, 'WRONG')).toBe(false);

    // 正确路径:注入一条已知验证码,验证大小写/空白归一化与一次性消费
    const id = 'test-fixed-id';
    (service as unknown as { store: Map<string, { code: string; expiresAt: number }> }).store.set(
      id,
      { code: 'AB12', expiresAt: Date.now() + 60_000 },
    );
    expect(service.verify(id, ' ab12 ')).toBe(true);
    expect(service.verify(id, 'AB12')).toBe(false); // 一次性:已被消费
  });

  it('过期验证码校验失败', () => {
    const service = new CaptchaService();
    const id = 'expired-id';
    (service as unknown as { store: Map<string, { code: string; expiresAt: number }> }).store.set(
      id,
      { code: 'AB12', expiresAt: Date.now() - 1 },
    );
    expect(service.verify(id, 'AB12')).toBe(false);
  });

  it('不存在的 captchaId 校验失败', () => {
    const service = new CaptchaService();
    expect(service.verify('nonexistent', 'AB12')).toBe(false);
  });

  it('issue 会清扫过期条目(不无限膨胀)', () => {
    vi.useFakeTimers();
    const service = new CaptchaService();
    const { captchaId } = service.issue();
    vi.advanceTimersByTime(6 * 60 * 1000); // 超过 5 分钟 TTL
    service.issue(); // 触发 sweep
    const store = (service as unknown as { store: Map<string, unknown> }).store;
    expect(store.has(captchaId)).toBe(false);
    vi.useRealTimers();
  });
});
