/**
 * 帧编解码（协议 v1）：`u32 BE 长度 + JSON(UTF-8)`，单帧上限 1 MiB。
 *
 * ⚠️ QUIC/WT 流是字节流：一次 read() 可能返回半个帧、也可能返回两个半帧。
 * FrameReader 维护累积缓冲，循环「够 4 字节读长度 → 够长度切帧 → 剩余留在缓冲」。
 * 与 Rust 侧 `apps/transport-server/src/proto.rs`、夹具
 * `packages/shared-types/fixtures/rt-*.json` 三方对齐；分片投喂单测见 frame.spec.ts。
 */

export const MAX_FRAME_LEN = 1_000_000;

/** 帧级错误（TooLarge/Closed 视为不可恢复，调用方应断开重连） */
export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** 往 WritableStream 写一帧（每帧独立 writer，写完即释放） */
export async function writeFrame(writable: WritableStream<Uint8Array>, value: unknown): Promise<void> {
  const json = textEncoder.encode(JSON.stringify(value));
  if (json.byteLength > MAX_FRAME_LEN) {
    throw new FrameError(`frame too large: ${json.byteLength} > ${MAX_FRAME_LEN}`);
  }
  const writer = writable.getWriter();
  try {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, json.byteLength);
    await writer.write(len);
    await writer.write(json);
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

/**
 * 累积缓冲帧读取器（状态机）。
 *
 * 用法：每条流一个 FrameReader，循环调 read()；流关闭（EOF）抛 Closed。
 * 读取器持有流直到读完（浏览器 WT 流未读尽时释放会打断服务端写端）。
 */
export class FrameReader {
  private buf = new Uint8Array(0);
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  constructor(private readonly stream: ReadableStream<Uint8Array>) {}

  /** 读出一帧并反序列化 */
  async read<T>(): Promise<T> {
    for (;;) {
      if (this.buf.length >= 4) {
        const len = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength).getUint32(0);
        if (len > MAX_FRAME_LEN) throw new FrameError(`frame too large: ${len} > ${MAX_FRAME_LEN}`);
        if (this.buf.length >= 4 + len) {
          const json = this.buf.slice(4, 4 + len);
          this.buf = this.buf.slice(4 + len);
          try {
            return JSON.parse(textDecoder.decode(json)) as T;
          } catch (error) {
            // 坏帧不可恢复：与超限同等处理（断开重连）
            throw new FrameError(`bad json: ${String(error)}`);
          }
        }
      }
      this.reader ??= this.stream.getReader();
      const { value, done } = await this.reader.read();
      if (done) {
        throw new FrameError(this.buf.length > 0 ? 'stream ended mid-frame' : 'stream closed');
      }
      this.buf = concat(this.buf, value);
    }
  }
}
