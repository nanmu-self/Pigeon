import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { PostgresRuntime } from '@prisma/orm-postgres/runtime';
import { db } from './prisma/db.js';

/**
 * Injectable wrapper around the Prisma 8 client (`src/prisma/db.ts`).
 *
 * The underlying connection pool is shared across all requests: it is
 * instantiated lazily on the first query and closed only on process
 * shutdown — never in request handlers.
 */
@Injectable()
export class PrismaService implements OnApplicationShutdown {
  private runtimeHandle: PostgresRuntime | null = null;

  /** Typed ORM surface — namespaced on PostgreSQL, e.g. `orm.public.User`. */
  get orm(): (typeof db)['orm'] {
    return db.orm;
  }

  /** Low-level SQL builder — e.g. `sql.public.user.select('id').limit(2)`. */
  get sql(): (typeof db)['sql'] {
    return db.sql;
  }

  /** Full Prisma 8 client (`db`). */
  get client() {
    return db;
  }

  /** Shared driver/pool handle; instantiates the pool on first call. */
  runtime(): PostgresRuntime {
    this.runtimeHandle ??= db.runtime();
    return this.runtimeHandle;
  }

  /** Close the shared pool on process shutdown only. */
  async onApplicationShutdown(): Promise<void> {
    await this.runtimeHandle?.close();
    this.runtimeHandle = null;
  }
}
