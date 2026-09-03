/**
 * 允许的前端来源（HTTP CORS 白名单）。
 *
 * Pigeon 是 Tauri 桌面应用直连 NestJS：
 *  - dev   阶段前端跑在 Vite（http://localhost:1420）；
 *  - 生产包 webview 的 origin 因平台而异（见 DEFAULT_ORIGINS）。
 * 可通过 CLIENT_ORIGINS 环境变量覆盖（逗号分隔，`*` 表示放行所有来源，仅限内网调试）。
 */
const DEFAULT_ORIGINS = [
  'http://localhost:1420', // Tauri dev（Vite dev server，见 tauri.conf.json devUrl）
  'tauri://localhost', // 生产 webview — macOS / iOS
  'http://tauri.localhost', // 生产 webview — Windows / Linux
  'https://tauri.localhost', // 生产 webview — Android
];

export function allowedOrigins(): string[] | true {
  const raw = process.env.CLIENT_ORIGINS;
  if (!raw) return DEFAULT_ORIGINS;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes('*') ? true : list;
}
