import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from './contract.d';

// swc 编译会丢弃 `with { type: "json" }` 导入属性，导致 Node ESM 拒绝加载，
// 因此改为运行时读取同目录的 contract.json ——
// 在 src/（tsx 直跑）与 dist/（nest build 经 nest-cli assets 拷贝）下均可用。
const here = dirname(fileURLToPath(import.meta.url));
const contractJson = JSON.parse(
  readFileSync(join(here, 'contract.json'), 'utf8'),
) as unknown;

export const db = postgres<Contract>({
  contractJson,
  url: process.env['DATABASE_URL']!,
});
