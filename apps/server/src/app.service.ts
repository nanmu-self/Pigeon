import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  /**
   * 探活响应；wsOnline 为当前实时通道在线数。
   *
   * ⚠️ 口径随 RT_TRANSPORT 而变（见迁移方案 §5）：
   *  - socket：Socket.IO 连接数；
   *  - wt：Nest presence 镜像里的**在线用户数**（去重，≠ 连接数）。
   * 灰度期两口径并存，看板对比时请注意。
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
