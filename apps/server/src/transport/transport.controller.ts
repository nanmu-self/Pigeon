import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { TransportConfig } from '@pigeon/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { resolveTransportSettings } from './config.js';
import { TransportCertService } from './transport-cert.service.js';

/**
 * GET /transport/config —— 客户端每次（重）连之前获取传输配置（D5 服务端开关）。
 *
 * - RT_TRANSPORT=wt：返回 Rust 侧指纹（certSha256 数组，轮换窗口期新旧并存）。
 * - RT_TRANSPORT=socket：返回 transport='socket'，客户端走旧实现。
 * - wt 模式但 Rust 不可达：**自动降级返回 socket**（混跑期最有价值的兜底；
 *   P4 删除 Socket.IO 后改为 503 + 客户端提示）。
 *
 * ⚠️ 客户端对响应禁止长缓存：证书轮换后旧指纹会导致新连接握手失败。
 * Nest 侧对 Rust /internal/cert 的缓存 ≤ 30s（TransportCertService）。
 */
@Controller('transport')
export class TransportController {
  constructor(
    @Inject(TransportCertService) private readonly certs: TransportCertService,
  ) {}

  @Get('config')
  @UseGuards(JwtAuthGuard)
  async config(): Promise<TransportConfig> {
    const settings = resolveTransportSettings();
    if (settings.mode !== 'wt') {
      return { transport: 'socket', url: '', certSha256: [], minClientProto: settings.minClientProto };
    }
    const cert = await this.certs.getCert();
    if (!cert || cert.certSha256.length === 0) {
      return { transport: 'socket', url: '', certSha256: [], minClientProto: settings.minClientProto };
    }
    return {
      transport: 'wt',
      url: settings.publicUrl,
      certSha256: cert.certSha256,
      minClientProto: settings.minClientProto,
    };
  }
}
