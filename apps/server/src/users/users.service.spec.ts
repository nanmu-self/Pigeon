import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { UsersService } from './users.service.js';
import type { UpdateProfileDto } from './dto.js';

const baseRow: {
  id: number;
  email: string;
  password: string;
  nickname: string;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
} = {
  id: 7,
  email: 'bob@test.local',
  password: '$2a$10$placeholderplaceholderplaceholderplaceholderplaceholder',
  nickname: 'Bob',
  avatarUrl: null,
  createdAt: '2026-01-01 00:00:00+00',
  updatedAt: '2026-01-01 00:00:00+00',
};

function makeService(row: typeof baseRow | null = baseRow) {
  const first = vi.fn(async () => row);
  const update = vi.fn(async (data: Record<string, string>) => ({ ...baseRow, ...data }));
  const ormUser = { first, where: vi.fn(() => ({ update })), update };
  const service = new UsersService({ orm: { public: { User: ormUser } } } as never);
  return { service, ormUser, update };
}

const dto = (over: Partial<UpdateProfileDto> = {}): UpdateProfileDto => ({ ...over });

describe('UsersService.me', () => {
  it('返回公开用户信息（avatarUrl 为空时不出现该键）', async () => {
    const { service } = makeService();
    const user = await service.me(7);
    expect(user).toEqual({ id: 7, email: 'bob@test.local', nickname: 'Bob', createdAt: baseRow.createdAt });
    expect('avatarUrl' in user).toBe(false);
  });

  it('带头像时返回 avatarUrl 外链', async () => {
    const { service } = makeService({ ...baseRow, avatarUrl: 'https://cdn.example.com/pigeon/avatar/a.png' });
    const user = await service.me(7);
    expect(user.avatarUrl).toBe('https://cdn.example.com/pigeon/avatar/a.png');
  });

  it('用户不存在时 404', async () => {
    const { service } = makeService(null);
    await expect(service.me(999)).rejects.toThrow(NotFoundException);
  });
});

describe('UsersService.updateMe', () => {
  it('部分更新：只写入出现的字段，昵称 trim 后入库', async () => {
    const { service, ormUser, update } = makeService();
    const user = await service.updateMe(7, dto({ nickname: '  Bob-b  ' }));

    expect(ormUser.where).toHaveBeenCalledWith({ id: 7 });
    expect(update).toHaveBeenCalledWith({ nickname: 'Bob-b' });
    expect(user.nickname).toBe('Bob-b');
  });

  it('头像与昵称可同时更新', async () => {
    const { service, update } = makeService();
    await service.updateMe(7, dto({ nickname: '新昵称', avatarUrl: 'https://cdn.example.com/a.png' }));
    expect(update).toHaveBeenCalledWith({ nickname: '新昵称', avatarUrl: 'https://cdn.example.com/a.png' });
  });

  it('空入参（无字段可更新）时 400', async () => {
    const { service } = makeService();
    await expect(service.updateMe(7, dto({}))).rejects.toThrow(BadRequestException);
  });

  it('目标用户不存在时 404（update 未命中返回 null）', async () => {
    const { service, update } = makeService();
    update.mockResolvedValueOnce(null as unknown as typeof baseRow);
    await expect(service.updateMe(999, dto({ nickname: '新名字' }))).rejects.toThrow(NotFoundException);
  });
});
