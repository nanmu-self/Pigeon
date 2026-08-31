import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CaptchaService } from './captcha.service.js';

/** token 有效期:7 天 */
export const JWT_EXPIRES_IN = '7d';

/**
 * 解析 JWT 密钥:优先读 JWT_SECRET 环境变量。
 * 未配置时每次启动随机生成(重启后所有已签发 token 失效)——
 * 这是安全的开发兜底;生产环境务必显式配置 JWT_SECRET。
 */
export function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 16) return secret;
  return randomBytes(32).toString('hex');
}

@Module({
  imports: [
    // global: JwtService 全应用可用(如 WS 网关验签),无需各模块重复注册
    JwtModule.register({
      global: true,
      secret: resolveJwtSecret(),
      signOptions: { expiresIn: JWT_EXPIRES_IN },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, CaptchaService],
  exports: [AuthService],
})
export class AuthModule {}
