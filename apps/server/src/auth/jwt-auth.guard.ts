import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { JwtPayload } from './auth.service.js';

/**
 * HTTP 请求的 JWT 鉴权守卫：校验 `Authorization: Bearer <jwt>`，
 * 验签通过后将 payload 挂到 `request.user` 供控制器读取。
 *
 * 与 WS 网关的握手验签共用同一套 JWT（AuthModule 全局注册的 JwtService）。
 * 本仓库用 swc 编译、不产出装饰器元数据，注入一律显式 @Inject。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string = request.headers?.authorization ?? '';
    const [scheme, token] = header.trim().split(/\s+/);

    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('缺少登录凭据');
    }
    try {
      request.user = await this.jwt.verifyAsync<JwtPayload>(token);
      return true;
    } catch {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
  }
}
