import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  /** 探活响应；wsOnline 为当前 Socket.IO 在线连接数 */
  getHealth(wsOnline = 0) {
    return {
      status: 'ok' as const,
      wsOnline,
      uptime: Math.round(process.uptime()),
      ts: Date.now(),
    };
  }
}
