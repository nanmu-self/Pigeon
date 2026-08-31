import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { generate } from 'primecaptcha';
import type { CaptchaChallenge } from '@pigeon/shared-types';

/** 验证码有效期:5 分钟 */
const CAPTCHA_TTL_MS = 5 * 60 * 1000;

/** 存储条目上限,防止未过期验证码被恶意刷取撑爆内存(超出时丢弃最早一条) */
const MAX_STORE = 10_000;

interface CaptchaEntry {
  code: string;
  expiresAt: number;
}

/**
 * 图形验证码:primecaptcha 生成,进程内 Map 存储,一次性使用。
 *
 * 安全语义:
 *  - 校验无论成败都立即作废(防爆破);
 *  - 忽略大小写与首尾空白(primecaptcha 输出恒为大写);
 *  - 签发时顺带清扫过期条目。
 *
 * 注意:进程内存储只适用于单实例;多实例/水平扩容时需换成 Redis 等共享存储。
 */
@Injectable()
export class CaptchaService {
  private readonly store = new Map<string, CaptchaEntry>();

  /** 签发一张 4 位文本验证码,返回 captchaId 与 PNG dataURL */
  issue(): CaptchaChallenge {
    this.sweep();

    const { text, image } = generate({
      type: 'text',
      width: 140,
      height: 48,
      length: 4,
      fontSize: 32,
      noiseIntensity: 6,
    });

    if (this.store.size >= MAX_STORE) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }

    const captchaId = randomBytes(16).toString('hex');
    this.store.set(captchaId, { code: text, expiresAt: Date.now() + CAPTCHA_TTL_MS });
    return { captchaId, image: `data:image/png;base64,${image.toString('base64')}` };
  }

  /** 校验并立即作废;返回是否通过 */
  verify(captchaId: string, code: string): boolean {
    const entry = this.store.get(captchaId);
    if (!entry) return false;
    this.store.delete(captchaId);
    return Date.now() <= entry.expiresAt && entry.code === code.trim().toUpperCase();
  }

  /** 清扫已过期条目(签发时触发即可,无需定时器) */
  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(id);
    }
  }
}
