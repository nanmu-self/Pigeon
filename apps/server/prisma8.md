# PostgreSQL (/docs/prisma-orm/add-to-existing-project/postgresql)

> For the complete Prisma documentation index, see [llms.txt](https://www.prisma.io/docs/llms.txt). A markdown version of any docs page is available by appending `.md` to its URL.

Add Prisma 8 to an existing PostgreSQL project.

Location: Prisma ORM > Add to Existing Project > PostgreSQL

To add Prisma 8 to a project that already uses PostgreSQL, you will run `orm init`, infer a contract from the live schema, sign the database, and run a couple of queries.

Use this path when you already have an application and database. Make sure the app can already reach its PostgreSQL database and runs on Node.js 24 or newer. If you want Prisma 8 to create a new app for you, use the [PostgreSQL quickstart](https://www.prisma.io/docs/prisma-orm/quickstart/postgresql).

> [!NOTE]
> Using Prisma 7?
> 
> Prisma 8 is the current release of Prisma ORM. Prisma 7 remains fully supported; its docs live at [/orm/v7](https://www.prisma.io/docs/orm/v7) and its setup paths at [/v7/getting-started](https://www.prisma.io/docs/v7/getting-started).

## 1. Make sure you can run the example script [#1-make-sure-you-can-run-the-example-script]

If your project already runs TypeScript scripts, you can skip this step.

Otherwise, install the script tooling:

  

#### bun

```bash
bun add --dev tsx typescript
```

#### pnpm

```bash
pnpm add --save-dev tsx typescript
```

#### yarn

```bash
yarn add --dev tsx typescript
```

#### npm

```bash
npm install --save-dev tsx typescript
```

Later, `orm init` will also add the Node.js types it needs and make sure the generated Prisma 8 files can run as ES modules. If your project already declares `"type": "commonjs"`, Prisma 8 leaves that choice alone and prints a warning so you can decide how to wire the generated helper into your app.

## 2. Initialize Prisma 8 [#2-initialize-prisma-8]

From the root of your existing project, run:

  

#### bun

```bash
bunx prisma@latest orm init --target postgres
```

#### pnpm

```bash
pnpm dlx prisma@latest orm init --target postgres
```

#### yarn

```bash
yarn dlx prisma@latest orm init --target postgres
```

#### npm

```bash
npx prisma@latest orm init --target postgres
```

This is the existing-project path. It preselects PostgreSQL, adds Prisma 8 files and package scripts to the app you already have, and does not scaffold a new framework project.

It also adds `prisma-next.md` and project-level Prisma 8 skills for Cursor, Claude Code, Codex, and Windsurf so your agent can read the Prisma 8 usage, upgrade, and extension-author guidance from the project.

When Prisma 8 asks the remaining setup questions:

* choose `PSL`
* keep the default schema path, `prisma/contract.prisma`

## 3. Set your database connection string [#3-set-your-database-connection-string]

Update `.env` with the connection string for the database your app already uses:

```text title=".env"
DATABASE_URL="postgres://username:password@host:5432/database?sslmode=require"
```

## 4. Infer a starter contract from the live database [#4-infer-a-starter-contract-from-the-live-database]

This step gives you a starting contract by reading the schema that already exists in PostgreSQL.

Run:

  

#### bun

```bash
bunx prisma@latest contract infer --output ./prisma/contract.prisma
```

#### pnpm

```bash
pnpm dlx prisma@latest contract infer --output ./prisma/contract.prisma
```

#### yarn

```bash
yarn dlx prisma@latest contract infer --output ./prisma/contract.prisma
```

#### npm

```bash
npx prisma@latest contract infer --output ./prisma/contract.prisma
```

The command writes a first draft of `prisma/contract.prisma`.

Open that file and review it before you go on. This is the moment to clean up model names, keep only the tables you want Prisma 8 to know about first, and make the file easier to read.

## 5. Emit the generated artifacts [#5-emit-the-generated-artifacts]

Once the contract looks right, this step turns it into the generated files the runtime and CLI use.

After you are happy with the contract, run:

  

#### bun

```bash
bunx prisma@latest contract emit
```

#### pnpm

```bash
pnpm dlx prisma@latest contract emit
```

#### yarn

```bash
yarn dlx prisma@latest contract emit
```

#### npm

```bash
npx prisma@latest contract emit
```

This refreshes `prisma/contract.json` and `prisma/contract.d.ts` so the runtime and query APIs are aligned with the contract you just reviewed.

## 6. Sign the database [#6-sign-the-database]

Record that the live database matches the emitted contract:

  

#### bun

```bash
bunx prisma@latest db sign
```

#### pnpm

```bash
pnpm dlx prisma@latest db sign
```

#### yarn

```bash
yarn dlx prisma@latest db sign
```

#### npm

```bash
npx prisma@latest db sign
```

This step matters in two common cases:

* the database has never been signed by Prisma 8 before
* the database was signed earlier, but under an older contract hash

## 7. Run a simple high-level query [#7-run-a-simple-high-level-query]

With the database signed, you can test the higher-level API first and confirm Prisma 8 is reading the existing schema correctly.

Create a `script.ts` file:

```typescript title="script.ts"
import "dotenv/config";
import { db } from "./prisma/db";

async function main() {
  const runtime = await db.connect({ url: process.env.DATABASE_URL! });

  const users = await db.orm.User
    .select("id", "email", "name")
    .take(2)
    .all();

  console.log(users);

  await runtime.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Run it:

  

#### bun

```bash
bunx tsx script.ts
```

#### pnpm

```bash
pnpm dlx tsx script.ts
```

#### yarn

```bash
yarn dlx tsx script.ts
```

#### npm

```bash
npx tsx script.ts
```

## 8. Run a simple low-level query [#8-run-a-simple-low-level-query]

After the ORM example, this step shows the lower-level SQL builder against the same existing schema.

Replace `script.ts` with this version:

```typescript title="script.ts"
import "dotenv/config";
import { db } from "./prisma/db";

async function main() {
  const runtime = await db.connect({ url: process.env.DATABASE_URL! });

  const plan = db.sql.user
    .select("id", "email", "name")
    .limit(2)
    .build();

  const rows = await db.runtime().execute(plan);
  console.log(rows);

  await runtime.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Run it again:

  

#### bun

```bash
bunx tsx script.ts
```

#### pnpm

```bash
pnpm dlx tsx script.ts
```

#### yarn

```bash
yarn dlx tsx script.ts
```

#### npm

```bash
npx tsx script.ts
```

## 9. Next steps [#9-next-steps]

When you change `prisma/contract.prisma`, emit the contract again:

  

#### bun

```bash
bunx prisma@latest contract emit
```

#### pnpm

```bash
pnpm dlx prisma@latest contract emit
```

#### yarn

```bash
yarn dlx prisma@latest contract emit
```

#### npm

```bash
npx prisma@latest contract emit
```

Use [db update](https://www.prisma.io/docs/cli/db-update) for a direct development update, or [migration plan](https://www.prisma.io/docs/cli/migration-plan) when you want a checked-in migration.

## Related pages

- [`MongoDB`](https://www.prisma.io/docs/prisma-orm/add-to-existing-project/mongodb): Add Prisma 8 to an existing MongoDB project.