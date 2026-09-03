import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  /**
   * 探活响应；wsOnline 为当前实时通道在线数。
   *
   * 口径：Nest presence 镜像里的**在线用户数**（去重，≠ 连接数；
   * 权威状态在 Rust，本值来自 delta + 30s 对账，见迁移方案 §5/D6）。
   */
  getHealth(wsOnline = 0) {
    return {
      status: 'ok' as const,
      wsOnline,
      uptime: Math.round(process.uptime()),
      ts: Date.now(),
    };
  }
}
