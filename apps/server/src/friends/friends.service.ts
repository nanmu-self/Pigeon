import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { FriendItem, FriendRequestItem, PublicUser } from '@pigeon/shared-types';
import { PrismaService } from '../prisma.service.js';
import { WsEventsService } from '../ws/ws-events.service.js';
import { toPublicUser } from '../users/user.mapper.js';
import { toFriendItem, toFriendRequestItem, type FriendshipRow } from './friends.mapper.js';

/**
 * 好友关系服务 —— 状态机实现（schema 注释里定义的六种动作）。
 *
 * 关系行按 userAId < userBId 归一化存储，所有读写前先归一化，
 * 配合唯一约束保证一对用户至多一行。
 *
 * 状态机速查：
 *   申请     无行 → pending；已有 pending/accepted → 409；
 *            任一方 blocked → 403（统一文案，不暴露被拉黑）
 *   通过     仅被申请方，pending → accepted
 *   拒绝     仅被申请方，pending → 删行
 *   删除     成员即可删行（任意状态）
 *   拉黑     任意状态 → blocked + blockedById；无行时直接建 blocked 行
 *   解除拉黑 acceptedAt 非空 → 恢复 accepted；否则删行回陌生人
 */
@Injectable()
export class FriendsService {
  constructor(
    // swc 编译无装饰器元数据，注入一律显式 @Inject（与全仓库约定一致）
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WsEventsService) private readonly ws: WsEventsService,
  ) {}

  /** 归一化：小 id 为 A，大 id 为 B（与 Session 同约定） */
  private normalize(a: number, b: number): [number, number] {
    return a < b ? [a, b] : [b, a];
  }

  /** 按成员对取关系行 */
  private async rowBetween(a: number, b: number): Promise<FriendshipRow | null> {
    const [userAId, userBId] = this.normalize(a, b);
    const row = await this.prisma.orm.public.Friendship.first({ userAId, userBId });
    return (row as FriendshipRow | null) ?? null;
  }

  /** 取公开资料（内部查询复用 user.mapper，不经 UsersService 免模块耦合） */
  private async publicUser(id: number): Promise<PublicUser> {
    const row = await this.prisma.orm.public.User.first({ id });
    if (!row) throw new NotFoundException('用户不存在');
    return toPublicUser(row);
  }

  /** 行内对端 id */
  private peerIdOf(row: FriendshipRow, meId: number): number {
    return row.userAId === meId ? row.userBId : row.userAId;
  }

  // ── 查询 ─────────────────────────────────────────────────

  /** 好友列表（accepted），按成为好友时间倒序 */
  async listFriends(meId: number): Promise<FriendItem[]> {
    const [asA, asB] = await Promise.all([
      this.prisma.orm.public.Friendship.where({ userAId: meId, status: 'accepted' }).all(),
      this.prisma.orm.public.Friendship.where({ userBId: meId, status: 'accepted' }).all(),
    ]);
    const rows = [...asA, ...asB] as FriendshipRow[];

    const items = await Promise.all(
      rows.map(async (row) => {
        const peer = await this.publicUser(this.peerIdOf(row, meId));
        return toFriendItem(row, meId, peer, this.ws.isOnline(String(peer.id)));
      }),
    );
    return items.sort((a, b) => b.since.localeCompare(a.since));
  }

  /** 我拉黑的用户列表（解除拉黑的入口；被别人拉黑的不在其中） */
  async listBlocked(meId: number): Promise<PublicUser[]> {
    const rows = (await this.prisma.orm.public.Friendship.where({
      status: 'blocked',
      blockedById: meId,
    }).all()) as FriendshipRow[];
    return Promise.all(rows.map((row) => this.publicUser(this.peerIdOf(row, meId))));
  }

  /** 待处理申请（incoming = 等我处理；outgoing = 等对方处理） */
  async listRequests(meId: number): Promise<FriendRequestItem[]> {
    const pending = await this.prisma.orm.public.Friendship.where({ status: 'pending' }).all();
    const mine = (pending as FriendshipRow[]).filter(
      (r) => r.userAId === meId || r.userBId === meId,
    );

    const items = await Promise.all(
      mine.map(async (row) => {
        const peer = await this.publicUser(this.peerIdOf(row, meId));
        return toFriendRequestItem(row, meId, peer);
      }),
    );
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ── 状态机 ───────────────────────────────────────────────

  /** 发起好友申请 */
  async sendRequest(meId: number, targetId: number): Promise<FriendRequestItem> {
    if (meId === targetId) throw new BadRequestException('不能添加自己为好友');
    const target = await this.publicUser(targetId); // 不存在 → 404

    const existing = await this.rowBetween(meId, targetId);
    if (existing) {
      if (existing.status === 'accepted') throw new ConflictException('你们已经是好友了');
      if (existing.status === 'blocked') {
        // 统一文案：不区分「我拉黑了对方」还是「被对方拉黑」
        throw new ForbiddenException('无法向该用户发送好友申请');
      }
      // pending：按方向给准确提示
      throw existing.requesterId === meId
        ? new ConflictException('已发送过好友申请，等待对方处理')
        : new ConflictException('对方已向你发送好友申请，请先处理');
    }

    const row = (await this.prisma.orm.public.Friendship.create({
      userAId: Math.min(meId, targetId),
      userBId: Math.max(meId, targetId),
      status: 'pending',
      requesterId: meId,
    })) as FriendshipRow;

    // 实时通知对方（不在线时客户端上线后经列表接口拉取兜底）
    const me = await this.publicUser(meId);
    this.ws.toUser(String(targetId), 'friend:request', { from: me, createdAt: row.createdAt });

    return toFriendRequestItem(row, meId, target);
  }

  /** 通过好友申请（仅被申请方） */
  async accept(meId: number, requestId: number): Promise<FriendItem> {
    const row = (await this.prisma.orm.public.Friendship.first({ id: requestId })) as FriendshipRow | null;
    if (!row || (row.userAId !== meId && row.userBId !== meId)) {
      throw new NotFoundException('申请不存在');
    }
    if (row.status !== 'pending') throw new ConflictException('该申请不在待处理状态');
    if (row.requesterId === meId) throw new ForbiddenException('不能通过自己发出的申请');

    const acceptedAt = new Date().toISOString();
    await this.prisma.orm.public.Friendship.where({ id: row.id }).update({
      status: 'accepted',
      acceptedAt,
    });

    // 实时通知申请人：申请被通过
    const accepter = await this.publicUser(meId);
    this.ws.toUser(String(row.requesterId), 'friend:accepted', { user: accepter, since: acceptedAt });

    const peer = await this.publicUser(this.peerIdOf(row, meId));
    return toFriendItem({ ...row, status: 'accepted', acceptedAt }, meId, peer, this.ws.isOnline(String(peer.id)));
  }

  /** 拒绝好友申请（仅被申请方）：删行，对方可再次申请 */
  async decline(meId: number, requestId: number): Promise<void> {
    const row = (await this.prisma.orm.public.Friendship.first({ id: requestId })) as FriendshipRow | null;
    if (!row || (row.userAId !== meId && row.userBId !== meId)) {
      throw new NotFoundException('申请不存在');
    }
    if (row.status !== 'pending') throw new ConflictException('该申请不在待处理状态');
    if (row.requesterId === meId) throw new ForbiddenException('不能拒绝自己发出的申请');

    await this.prisma.orm.public.Friendship.where({ id: row.id }).delete();
  }

  /** 删除好友关系（任意状态，成员即可）：会话与历史保留 */
  async remove(meId: number, peerId: number): Promise<void> {
    const row = await this.rowBetween(meId, peerId);
    if (!row) throw new NotFoundException('你们还不是好友');
    await this.prisma.orm.public.Friendship.where({ id: row.id }).delete();
  }

  /** 拉黑：任意状态可拉黑；无关系行时直接建 blocked 行（屏蔽陌生人再申请） */
  async block(meId: number, peerId: number): Promise<void> {
    if (meId === peerId) throw new BadRequestException('不能拉黑自己');
    await this.publicUser(peerId); // 不存在 → 404

    const existing = await this.rowBetween(meId, peerId);
    if (!existing) {
      await this.prisma.orm.public.Friendship.create({
        userAId: Math.min(meId, peerId),
        userBId: Math.max(meId, peerId),
        status: 'blocked',
        requesterId: meId,
        blockedById: meId,
      });
      return;
    }
    // 已被对方拉黑时再拉黑 → 覆盖 blockedById（最后一拉生效，见 schema 约定）
    await this.prisma.orm.public.Friendship.where({ id: existing.id }).update({
      status: 'blocked',
      blockedById: meId,
    });
  }

  /** 解除拉黑：曾是好友（acceptedAt 非空）→ 恢复 accepted；否则删行回陌生人 */
  async unblock(meId: number, peerId: number): Promise<void> {
    const row = await this.rowBetween(meId, peerId);
    if (!row || row.status !== 'blocked' || row.blockedById !== meId) {
      // 统一 404：不暴露「被谁拉黑」的细节
      throw new NotFoundException('拉黑关系不存在');
    }
    if (row.acceptedAt) {
      await this.prisma.orm.public.Friendship.where({ id: row.id }).update({
        status: 'accepted',
        blockedById: null,
      });
    } else {
      await this.prisma.orm.public.Friendship.where({ id: row.id }).delete();
    }
  }

  // ── 内部校验（供会话/消息链路复用） ─────────────────────

  /**
   * 校验两人是 accepted 好友（未拉黑），不满足抛 403。
   * 发消息、建会话前都必须过这道闸。
   */
  async assertFriends(aId: number, bId: number): Promise<void> {
    const row = await this.rowBetween(aId, bId);
    if (!row || row.status !== 'accepted') {
      throw new ForbiddenException('仅好友之间可以进行该操作');
    }
  }
}
