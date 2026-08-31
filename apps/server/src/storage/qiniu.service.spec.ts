import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { QiniuStorageService } from './qiniu.service.js';

const ENV: Record<string, string> = {
  QINIU_ACCESS_KEY: 'test-ak',
  QINIU_SECRET_KEY: 'test-sk',
  QINIU_BUCKET: 'test-bucket',
  QINIU_DOMAIN: 'https://cdn.example.com/',
};

function stubEnv() {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('QiniuStorageService', () => {
  it('未配置环境变量时以 503 拒绝颁发', () => {
    const svc = new QiniuStorageService();
    expect(() => svc.issueTicket({})).toThrow(ServiceUnavailableException);
  });

  it('token 结构为 ak:sign:policy，签名可由 SecretKey 复算验证', () => {
    stubEnv();
    const svc = new QiniuStorageService();
    const ticket = svc.issueTicket({ dir: 'avatar', fileName: 'photo.PNG' });

    const [ak, sign, encodedPolicy] = ticket.token.split(':');
    expect(ak).toBe('test-ak');

    // 按官方算法复算：hmac_sha1(encodedPutPolicy, SecretKey) → urlsafe base64（保留 padding）
    const expected = createHmac('sha1', 'test-sk')
      .update(encodedPolicy, 'utf8')
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(sign).toBe(expected);

    const policy = JSON.parse(Buffer.from(encodedPolicy, 'base64url').toString('utf8'));
    expect(policy.scope).toBe(`test-bucket:${ticket.key}`);
    expect(policy.deadline).toBe(ticket.expiresAt);
    expect(policy.insertOnly).toBe(1);
    expect(policy.fsizeLimit).toBe(5 * 1024 * 1024);
    expect(policy.mimeLimit).toContain('image/jpeg');
  });

  it('key 目录收敛 + 可疑扩展名被净化，publicUrl = domain/key', () => {
    stubEnv();
    const svc = new QiniuStorageService();
    const ticket = svc.issueTicket({ dir: 'chat', fileName: '../../evil.exe?x=1' });

    // 路径 / 查询串不进入 key；'?x=1' 使扩展名非法 → 直接不带扩展名
    expect(ticket.key).toMatch(/^pigeon\/chat\/\d{6}\/[0-9a-f-]{36}$/);
    expect(ticket.key).not.toContain('evil');
    expect(ticket.publicUrl).toBe(`https://cdn.example.com/${ticket.key}`);
    expect(ticket.maxSize).toBe(100 * 1024 * 1024);
    expect(ticket.region).toBe('z0'); // 未设置 QINIU_REGION 时的默认值
  });

  it('不传 dir 时默认 file 目录', () => {
    stubEnv();
    const svc = new QiniuStorageService();
    const ticket = svc.issueTicket({ fileName: 'a.zip' });
    expect(ticket.key.startsWith('pigeon/file/')).toBe(true);
  });

  describe('issueSessionTicket', () => {
    it('scope 为整个 bucket（不限 key），供客户端复用 + 自行生成 key', () => {
      stubEnv();
      const svc = new QiniuStorageService();
      const s = svc.issueSessionTicket('chat');

      const [, , encodedPolicy] = s.token.split(':');
      const policy = JSON.parse(Buffer.from(encodedPolicy, 'base64url').toString('utf8'));
      expect(policy.scope).toBe('test-bucket'); // 不带 :key
      expect(policy.insertOnly).toBe(1);
      expect(policy.fsizeLimit).toBe(100 * 1024 * 1024); // chat 目录限制
      expect(policy.mimeLimit).toBeUndefined();
      expect(policy.deadline).toBe(s.expiresAt);
      expect(s.maxSize).toBe(100 * 1024 * 1024);
    });

    it('file 目录会话凭证的 fsizeLimit 为 200MB', () => {
      stubEnv();
      const svc = new QiniuStorageService();
      const s = svc.issueSessionTicket('file');
      expect(s.maxSize).toBe(200 * 1024 * 1024);
    });

    it('未配置环境变量时以 503 拒绝', () => {
      const svc = new QiniuStorageService();
      expect(() => svc.issueSessionTicket('chat')).toThrow(ServiceUnavailableException);
    });
  });
});
