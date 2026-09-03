import { Controller, Get, HttpException, Inject, UseGuards } from '@nestjs/common';
import type { TransportConfig } from '@pigeon/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { resolveTransportSettings } from './config.js';
import { TransportCertService } from './transport-cert.service.js';

/**
 * GET /transport/config —— 客户端每次（重）连之前获取传输配置。
 *
 * WebTransport 是唯一实时通道（P4 起 Socket.IO 已删）。Rust 传输服务不可达
 * （cert 拿不到）时返回 503：客户端按连接失败退避重试，服务恢复后自动连上。
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
    const cert = await this.certs.getCert();
    if (!cert || cert.certSha256.length === 0) {
      throw new HttpException('实时传输服务不可达，请稍后重试', 503);
    }
    return {
      transport: 'wt',
      url: settings.publicUrl,
      certSha256: cert.certSha256,
      minClientProto: settings.minClientProto,
    };
  }
}
