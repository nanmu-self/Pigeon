/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** NestJS 服务端地址（HTTP + Socket.IO 共用），如 http://localhost:3048 */
  readonly VITE_PIGEON_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
