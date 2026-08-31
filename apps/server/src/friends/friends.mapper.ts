import type {
  FriendItem,
  FriendRequestItem,
  PublicUser,
} from '@pigeon/shared-types';

/** Friendship 表行结构（Prisma 查询返回的字段） */
export interface FriendshipRow {
  id: number;
  userAId: number;
  userBId: number;
  status: 'pending' | 'accepted' | 'blocked';
  requesterId: number;
  blockedById: number | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 好友列表行 → FriendItem（online 由调用方根据 presence 注册表填入） */
export function toFriendItem(row: FriendshipRow, meId: number, peer: PublicUser, online: boolean): FriendItem {
  return {
    user: peer,
    online,
    since: row.acceptedAt ?? row.createdAt,
  };
}

/** 申请行 → FriendRequestItem（user 恒为对方，direction 标明流向） */
export function toFriendRequestItem(
  row: FriendshipRow,
  meId: number,
  peer: PublicUser,
): FriendRequestItem {
  const direction = row.requesterId === meId ? 'outgoing' : 'incoming';
  return {
    id: row.id,
    direction,
    user: peer,
    createdAt: row.createdAt,
  };
}
