/**
 * 服务端地址解析。
 *
 * 优先级：VITE_PIGEON_SERVER_URL（.env / 构建时环境变量）> 开发默认 localhost:3048。
 * 注意：Tauri 生产包里 import.meta.env 是构建期内联的 —— 改地址需要重新构建，
 * 想支持运行时切换可将该值挪到 Tauri 的 store（tauri-plugin-store）里。
 */
export const SERVER_URL: string = (
  import.meta.env.VITE_PIGEON_SERVER_URL ?? 'http://localhost:3048'
).replace(/\/+$/, '');
