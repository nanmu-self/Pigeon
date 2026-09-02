import { http } from '../api/http';
import type { TransportConfig } from '@pigeon/shared-types';

/**
 * 取传输配置（GET /transport/config，JwtAuthGuard）。
 *
 * ⚠️ 每次（重）连之前都要重新调用，禁止长缓存（D5/D3）：
 *  - transport 字段是服务端灰度/回退的权威开关；
 *  - 证书轮换窗口期指纹会变，拿旧指纹连新证书会握手失败。
 * 401（未登录/过期）直接抛 ApiError，由连接状态机决定是否重试。
 */
export function fetchTransportConfig(): Promise<TransportConfig> {
  return http.Get<TransportConfig>('/transport/config');
}
