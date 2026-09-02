import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { assertInternalAccess } from './config.js';

/**
 * 内部 API 防线（§6.5 第 2 层）：x-internal-token（fail-closed）+
 * 可选来源网段校验（INTERNAL_ALLOWED_CIDRS）。
 * 第 1 层（OpenResty deny /internal/）与第 3 层（独立内网监听）见 deploy/README.md。
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key] = Array.isArray(value) ? value[0] : value;
    }
    const remoteIp = request.socket?.remoteAddress ?? request.ip;
    if (!assertInternalAccess(headers, remoteIp)) {
      throw new UnauthorizedException('internal access denied');
    }
    return true;
  }
}
