import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CallService } from '../call/call.service.js';
import { WsEventsService } from '../ws/ws-events.service.js';
import { PresenceMirrorService } from './presence-mirror.service.js';
import { InternalPresenceController } from './internal-presence.controller.js';

/**
 * presence delta 落地：
 *  - applied + offline → 广播离线 + 清理进行中通话（对齐 socket 网关 handleDisconnect 语义）；
 *  - stale / epoch-reset → 既不广播也不清理（镜像未真正变化 / Rust 重启对账中）。
 */

type DeltaBody = Parameters<InternalPresenceController['delta']>[0];

function makeController(applied: 'applied' | 'stale' | 'epoch-reset') {
  const mirror = { applyDelta: vi.fn(() => applied) };
  const events = { broadcast: vi.fn() };
  const calls = { handleUserOffline: vi.fn() };
  const controller = new InternalPresenceController(
    mirror as unknown as PresenceMirrorService,
    events as unknown as WsEventsService,
    calls as unknown as CallService,
  );
  return { controller, mirror, events, calls };
}

describe('InternalPresenceController.delta', () => {
  it('offline delta 生效：广播离线，并清理该用户进行中通话', async () => {
    const { controller, mirror, events, calls } = makeController('applied');
    const body: DeltaBody = { epoch: 'e1', seq: 3, userId: '42', online: false, at: 123 };

    await expect(controller.delta(body)).resolves.toEqual({ ok: true, applied: 'applied' });
    expect(mirror.applyDelta).toHaveBeenCalledWith({ epoch: 'e1', seq: 3, userId: '42', online: false });
    expect(events.broadcast).toHaveBeenCalledWith('presence:update', {
      userId: '42',
      online: false,
      at: 123,
    });
    expect(calls.handleUserOffline).toHaveBeenCalledWith(42);
  });

  it('online delta 生效：广播上线，不触发通话清理', async () => {
    const { controller, events, calls } = makeController('applied');

    await controller.delta({ epoch: 'e1', seq: 1, userId: '42', online: true });
    expect(events.broadcast).toHaveBeenCalledWith(
      'presence:update',
      expect.objectContaining({ userId: '42', online: true }),
    );
    expect(calls.handleUserOffline).not.toHaveBeenCalled();
  });

  it('stale（重复/乱序）：不广播、不清理', async () => {
    const { controller, events, calls } = makeController('stale');

    await expect(controller.delta({ epoch: 'e1', seq: 2, userId: '42', online: false })).resolves.toEqual({
      ok: true,
      applied: 'stale',
    });
    expect(events.broadcast).not.toHaveBeenCalled();
    expect(calls.handleUserOffline).not.toHaveBeenCalled();
  });

  it('epoch-reset（Rust 重启）：不广播、不清理', async () => {
    const { controller, events, calls } = makeController('epoch-reset');

    await controller.delta({ epoch: 'e2', seq: 1, userId: '42', online: false });
    expect(events.broadcast).not.toHaveBeenCalled();
    expect(calls.handleUserOffline).not.toHaveBeenCalled();
  });

  it('缺 epoch/seq/userId → 400，且不触碰镜像', async () => {
    const { controller, mirror } = makeController('applied');

    await expect(controller.delta({ seq: 1, userId: '42', online: true })).rejects.toThrow(BadRequestException);
    await expect(controller.delta({ epoch: 'e1', userId: '42', online: true })).rejects.toThrow(BadRequestException);
    await expect(controller.delta({ epoch: 'e1', seq: 1, online: true })).rejects.toThrow(BadRequestException);
    expect(mirror.applyDelta).not.toHaveBeenCalled();
  });
});
