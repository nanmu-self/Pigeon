import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import type { RegisterDto } from './dto.js';

const baseRow = {
  id: 1,
  email: 'alice@test.local',
  password: '$2a$10$placeholderplaceholderplaceholderplaceholderplaceholder',
  nickname: 'Alice',
  createdAt: '2026-01-01 00:00:00+00',
  updatedAt: '2026-01-01 00:00:00+00',
};

function makeService() {
  const first = vi.fn<(q: { email: string }) => Promise<typeof baseRow | null>>(
    async () => null,
  );
  const create = vi.fn<(data: Record<string, string>) => Promise<typeof baseRow>>(
    async (data) => ({ ...baseRow, ...data }),
  );
  const ormUser = { first, create };
  const prisma = { orm: { public: { User: ormUser } } };
  const jwt = { sign: vi.fn(() => 'jwt-token') };
  const captcha = { verify: vi.fn(() => true) };
  const service = new AuthService(
    prisma as never,
    jwt as unknown as JwtService,
    captcha as never,
  );
  return { service, ormUser, jwt, captcha, create };
}

const registerDto = (over: Partial<RegisterDto> = {}): RegisterDto => ({
  email: '  Alice@Test.Local  ',
  password: 'sup3r-secret!',
  nickname: '  Alice  ',
  captchaId: 'captcha-id-1',
  captchaCode: 'AB12',
  ...over,
});

describe('AuthService.register', () => {
  it('归一化邮箱/昵称,密码哈希后入库,返回公开用户信息与 token', async () => {
    const { service, ormUser, jwt, captcha, create } = makeService();

    const result = await service.register(registerDto());

    expect(ormUser.first).toHaveBeenCalledWith({ email: 'alice@test.local' });
    expect(captcha.verify).toHaveBeenCalledWith('captcha-id-1', 'AB12');
    expect(ormUser.create).toHaveBeenCalledTimes(1);

    const stored = create.mock.calls[0][0];
    expect(stored.email).toBe('alice@test.local');
    expect(stored.nickname).toBe('Alice');
    // 入库的是哈希,且能反推出原始明文
    expect(stored.password).not.toBe('sup3r-secret!');
    expect(await compare('sup3r-secret!', stored.password)).toBe(true);

    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, email: 'alice@test.local', nickname: 'Alice' }),
    );
    expect(result.token).toBe('jwt-token');
    expect(result.user).toEqual({
      id: 1,
      email: 'alice@test.local',
      nickname: 'Alice',
      createdAt: baseRow.createdAt,
    });
    expect(result.user).not.toHaveProperty('password');
  });

  it('验证码不通过 → 400,且不触发任何账号查询', async () => {
    const { service, ormUser, captcha } = makeService();
    captcha.verify.mockReturnValue(false);

    await expect(service.register(registerDto())).rejects.toThrow(BadRequestException);
    await expect(
      service.login({ email: 'any@test.local', password: 'whatever-123', captchaId: 'x', captchaCode: 'Y' }),
    ).rejects.toThrow(BadRequestException);
    expect(ormUser.first).not.toHaveBeenCalled();
  });

  it('邮箱已存在 → 409', async () => {
    const { service, ormUser } = makeService();
    ormUser.first.mockResolvedValue(baseRow);

    await expect(service.register(registerDto())).rejects.toThrow(ConflictException);
    expect(ormUser.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.login', () => {
  it('密码正确 → 返回用户信息与 token', async () => {
    const { service, ormUser, create } = makeService();
    // 先注册一次,拿到真实 bcrypt 哈希
    const registered = await service.register(registerDto());
    ormUser.first.mockResolvedValue({ ...baseRow, password: create.mock.calls[0][0].password });

    const result = await service.login({
      email: 'Alice@Test.Local',
      password: 'sup3r-secret!',
      captchaId: 'captcha-id-1',
      captchaCode: 'AB12',
    });

    expect(result.user.email).toBe('alice@test.local');
    expect(result.token).toBe(registered.token);
  });

  it('邮箱不存在 → 401(文案与密码错误一致,防枚举)', async () => {
    const { service } = makeService();

    await expect(
      service.login({ email: 'nobody@test.local', password: 'whatever-123', captchaId: 'x', captchaCode: 'Y' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('密码错误 → 401', async () => {
    const { service, ormUser, create } = makeService();
    await service.register(registerDto());
    ormUser.first.mockResolvedValue({
      ...baseRow,
      password: create.mock.calls[0][0].password,
    });

    await expect(
      service.login({ email: 'alice@test.local', password: 'wrong-password', captchaId: 'x', captchaCode: 'Y' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
