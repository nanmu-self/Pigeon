# @pigeon/server

NestJS 12 API with Prisma 8 (PostgreSQL).

## Prisma 8 layout

| Path | Purpose |
| --- | --- |
| `src/prisma/contract.prisma` | Contract (schema) — source of truth, authored in PSL |
| `src/prisma/contract.json` / `contract.d.ts` | Generated artifacts (do not edit) |
| `src/prisma/db.ts` | Prisma 8 client instance (`db`) |
| `src/prisma.service.ts` | Injectable wrapper (`PrismaModule`, global) |
| `prisma.config.ts` | CLI config (contract path + connection) |
| `scripts/prisma-smoke.ts` | ORM + SQL builder smoke test |

## Setup

1. Set your PostgreSQL connection string in `.env` (PostgreSQL >= 15):

   ```text
   DATABASE_URL="postgresql://user:password@host:5432/dbname?sslmode=require"
   ```

2. If the database already has tables, infer the contract from it, then re-emit:

   ```bash
   pnpm contract:infer   # overwrites src/prisma/contract.prisma — review it
   pnpm contract:emit    # refresh contract.json + contract.d.ts
   ```

3. Sign the database and verify connectivity:

   ```bash
   pnpm db:sign
   pnpm db:smoke         # runs one typed ORM query + one SQL-builder query
   ```

## Auth

- `GET /auth/captcha` → `{ captchaId, image }`(PNG dataURL,primecaptcha 生成，一次性、5 分钟有效)
- `POST /auth/register` `{ email, password(8~72), nickname(2~32), captchaId, captchaCode }` → `201` `{ user, token }`(密码 bcrypt 哈希入库，邮箱小写归一，重复返回 409)
- `POST /auth/login` `{ email, password, captchaId, captchaCode }` → `200` `{ user, token }`(JWT，有效期 7 天，密钥读 `JWT_SECRET`)
- 验证码不通过 → 400 且 captchaId 立即作废(一次性，重试需拉新码)；验证码校验先于账号存在性检查，不可用于探测邮箱
- 入参由全局 ValidationPipe(class-validator)校验：未知字段/格式错误 → 400
- 实时通道为 WebTransport（Rust 网关）：客户端 hello 握手携带 JWT，Rust 验签后注册连接；JWT 密钥与本服务共享（`JWT_SECRET`，必填 ≥16 字节）
- 桌面端“记住我”：勾选 → token 存 localStorage(跨重启)；不勾 → sessionStorage(仅会话)

## Workflow after changing the contract

```bash
pnpm contract:emit     # re-emit artifacts, then use the new types
pnpm db:update         # apply schema changes directly (dev)
```

## Query surfaces

PostgreSQL model access is namespace-qualified:

```ts
// typed ORM API
const users = await prisma.orm.public.User.select('id', 'email').limit(2).all();

// low-level SQL builder
const plan = prisma.sql.public.user.select('id', 'email').limit(2).build();
const rows = await prisma.runtime().execute(plan);
```

The connection pool is shared and created lazily; it is closed only on process
shutdown (`OnApplicationShutdown` + `app.enableShutdownHooks()`). Never close
it in request handlers.

> Tip: esbuild/swc-based runners (vite, tsx, swc) do not emit decorator
> metadata — always add explicit `@Inject(PrismaService)` tokens when
> injecting the service into constructors.
