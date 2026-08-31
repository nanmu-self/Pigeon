import 'dotenv/config';
import { db } from '../src/prisma/db.js';
import { PrismaService } from '../src/prisma.service.js';

/**
 * Prisma 8 smoke test — run with `pnpm --filter @pigeon/server db:smoke`
 * after DATABASE_URL points at a reachable PostgreSQL database.
 *
 * Exercises both query surfaces from the integration guide:
 *  1. high-level typed ORM API  (db.orm.public.User)
 *  2. low-level SQL builder API (db.sql + runtime().execute)
 */
async function main() {
  const prisma = new PrismaService();

  const runtime = await db.connect({ url: process.env.DATABASE_URL! });
  try {
    // 1. High-level query — adjust the model/fields to your contract.
    const users = await db.orm.public.User.select('id', 'email', 'nickname').limit(2).all();
    console.log('orm:', users);

    // 2. Low-level query — plan is built locally, executed via the runtime.
    const plan = db.sql.public.user.select('id', 'email', 'nickname').limit(2).build();
    const rows = await prisma.runtime().execute(plan);
    console.log('sql:', rows);
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
