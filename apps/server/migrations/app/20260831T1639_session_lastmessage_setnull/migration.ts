#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/37d533050215b4c62589f7c14d67c4ae277d4324e5cd84ba833e69fad794e5d9/contract';
import endContract from '../../snapshots/37d533050215b4c62589f7c14d67c4ae277d4324e5cd84ba833e69fad794e5d9/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

/**
 * session.lastMessageId 外键动作 Restrict → SetNull。
 *
 * 原因：message.sessionId（Restrict，指向 session）与
 * session.lastMessageId（Restrict，指向 message）构成循环锁 ——
 * 消息被会话指针引用时删不掉，会话又被消息引用时删不掉，
 * 单独删除任何一条消息都不可能。SetNull 让「删除消息」自动
 * 清空会话的最后消息指针，循环得以解开。
 */
export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      {
        kind: 'sql' as const,
        id: 'foreignKey.session.session_lastMessageId_fkey.setnull',
        label: 'Alter foreign key "session_lastMessageId_fkey" to ON DELETE SET NULL',
        operationClass: 'widening' as const,
        sql: [
          `ALTER TABLE "public"."session"`,
          `  DROP CONSTRAINT "session_lastMessageId_fkey",`,
          `  ADD CONSTRAINT "session_lastMessageId_fkey"`,
          `  FOREIGN KEY ("lastMessageId") REFERENCES "public"."message"("id") ON DELETE SET NULL`,
        ].join('\n'),
      },
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
