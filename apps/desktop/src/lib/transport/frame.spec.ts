import { describe, expect, it } from 'vitest';
import { FrameError, FrameReader, writeFrame } from './frame';

/**
 * 帧编解码单测（对齐 Rust 侧 proto.rs 的同名用例）：
 * 往返、逐字节分片投喂、半帧留存、超限拒绝、坏 JSON 拒绝。
 */

/** 单帧 writable（writeFrame 每帧写完即 close —— RPC 流一帧一生的协议约定） */
function frameWritable(): { writable: WritableStream<Uint8Array>; bytes: () => Uint8Array } {
  const frames: Uint8Array[] = [];
  return {
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        frames.push(chunk);
      },
    }),
    bytes: () => {
      const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
      let offset = 0;
      for (const f of frames) {
        out.set(f, offset);
        offset += f.length;
      }
      return out;
    },
  };
}

/** 可控流：测试中途推字节（验证累积缓冲状态机） */
function controlled(): {
  stream: ReadableStream<Uint8Array>;
  push: (bytes: Uint8Array) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (bytes) => controller!.enqueue(bytes),
    close: () => controller!.close(),
  };
}

/** 逐字节投喂的 mock 流：模拟最恶劣的分片 */
function byteByByte(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array([bytes[i]]));
      i += 1;
    },
  });
}

function chunked(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}

describe('frame.ts（协议 v1：u32 BE + JSON）', () => {
  it('writeFrame 输出「4 字节 BE 长度 + JSON」', async () => {
    const frames: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        frames.push(chunk);
      },
    });
    await writeFrame(writable, { seq: 7, type: 'message:new' }); // eslint 场景外：writable 单帧
    const len = new DataView(frames[0].buffer).getUint32(0);
    const json = new TextDecoder().decode(frames[1]);
    expect(len).toBe(frames[1].byteLength);
    expect(JSON.parse(json)).toEqual({ seq: 7, type: 'message:new' });
  });

  it('往返：写 → 读 还原对象', async () => {
    const f = frameWritable();
    await writeFrame(f.writable, { id: 42, ok: true, data: { a: 1 } });
    const reader = new FrameReader(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(f.bytes());
        controller.close();
      },
    }));
    expect(await reader.read()).toEqual({ id: 42, ok: true, data: { a: 1 } });
  });

  it('逐字节分片投喂 + 连续多帧 + EOF', async () => {
    const f1 = frameWritable();
    const f2 = frameWritable();
    await writeFrame(f1.writable, { id: 1, type: 'message:send', payload: { a: 1 } });
    await writeFrame(f2.writable, { id: 2, type: 'message:read', payload: { b: [1, 2, 3] } });
    const bytes = new Uint8Array([...f1.bytes(), ...f2.bytes()]);

    const reader = new FrameReader(byteByByte(bytes));
    expect(await reader.read()).toEqual({ id: 1, type: 'message:send', payload: { a: 1 } });
    expect(await reader.read()).toEqual({ id: 2, type: 'message:read', payload: { b: [1, 2, 3] } });
    await expect(reader.read()).rejects.toThrow('stream closed');
  });

  it('半帧留存：剩余字节留缓冲，补齐后切出完整帧', async () => {
    const frame = { x: 'y' };
    const json = new TextEncoder().encode(JSON.stringify(frame));
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, json.byteLength);

    const { stream, push, close } = controlled();
    const reader = new FrameReader(stream);

    // 先推 1.5 帧：第一帧完整 + 第二帧的长度前缀和半个 body
    push(new Uint8Array([...head, ...json, ...head, ...json.slice(0, 3)]));
    const p1 = reader.read();
    await expect(p1).resolves.toEqual(frame);

    // 补齐第二帧剩余 body（旧字节必须在缓冲里没丢）
    push(json.slice(3));
    await expect(reader.read()).resolves.toEqual(frame);

    close();
    await expect(reader.read()).rejects.toThrow('stream closed');
  });

  it('超限帧（> 1 MiB）拒绝', async () => {
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, 1_000_001);
    const reader = new FrameReader(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head);
        controller.close();
      },
    }));
    await expect(reader.read()).rejects.toThrow('too large');
  });

  it('坏 JSON 拒绝', async () => {
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, 3);
    const reader = new FrameReader(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head);
        controller.enqueue(new TextEncoder().encode('xyz'));
        controller.close();
      },
    }));
    await expect(reader.read()).rejects.toBeInstanceOf(FrameError);
  });

  it('中途 EOF（帧写一半就断）报错而非静默', async () => {
    const json = new TextEncoder().encode('{"a":1}');
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, json.byteLength);
    const reader = new FrameReader(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head);
        controller.enqueue(json.slice(0, 3)); // 半帧
        controller.close();
      },
    }));
    await expect(reader.read()).rejects.toThrow('mid-frame');
  });
});
