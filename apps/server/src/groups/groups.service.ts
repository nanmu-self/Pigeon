/**
 * 群聊服务 —— 群生命周期与管理（建群/邀请/踢出/转让/退群/公告/禁言/成员列表）。
 *
 * 角色权限矩阵：
 *   | 操作           | 群主 | 管理员 | 成员 |
 *   | 邀请/踢出成员   |  ✓  |   ✓   |  ✗  |
 *   | 改名/头像/公告  |  ✓  |   ✓   |  ✗  |
 *   | 禁言开关        |  ✓  |   ✓   |  ✗  |
 *   | 转让群主        |  ✓  |   ✗   |  ✗  |
 *   | 踢出对象        | 管理员+成员 | 仅成员 |  — |
 *   | 退群           |  ✓（需先转让） | ✓ | ✓ |
 *
 * 成员变动（邀请/踢出/退群）会落一条 system 消息（复用消息链路 fan-out），
 * 全员在聊天流中可见，并广播 group:updated 提示客户端刷新。
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  GroupDetail,
  GroupMemberItem,
  PublicUser,
  SessionSummary,
} from '@pigeon/shared-types';
import { PrismaService } from '../prisma.service.js';
import { WsEventsService } from '../ws/ws-events.service.js';
import { toPublicUser } from '../users/user.mapper.js';
import { pgTimestampToMs, toChatMessage, type MessageRow, type SessionRow } from '../sessions/sessions.mapper.js';

/** 群规模上限 */
const MAX_MEMBERS = 200;

type Role = 'owner' | 'admin' | 'member';

@Injectable()
export class GroupsService {
  constructor(
    // swc 编译无装饰器元数据，注入一律显式 @Inject（与全仓库约定一致）
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WsEventsService) private readonly ws: WsEventsService,
  ) {}

  private async sessionRow(id: number): Promise<SessionRow | null> {
    const row = await this.prisma.orm.public.Session.first({ id });
    return (row as SessionRow | null) ?? null;
  }

  private async assertGroup(sessionId: number): Promise<SessionRow> {
    const row = await this.sessionRow(sessionId);
    if (!row || row.kind !== 'group') throw new NotFoundException('群聊不存在');
    return row;
  }

  /** 取我的成员行（未入群 → 403） */
  private async myMember(sessionId: number, userId: number): Promise<{ role: Role }> {
    const member = await this.prisma.orm.public.SessionMember.first({ sessionId, userId });
    if (!member) throw new ForbiddenException('你不是该群聊的成员');
    return { role: member.role as Role };
  }

  private async requireRole(sessionId: number, userId: number, roles: Role[]): Promise<Role> {
    const { role } = await this.myMember(sessionId, userId);
    if (!roles.includes(role)) throw new ForbiddenException('没有权限执行该操作');
    return role;
  }

  private async publicUser(id: number): Promise<PublicUser> {
    const row = await this.prisma.orm.public.User.first({ id });
    if (!row) throw new NotFoundException('用户不存在');
    return toPublicUser(row);
  }

  /** 群成员 id 列表 */
  private async memberIds(sessionId: number): Promise<number[]> {
    const rows = (await this.prisma.orm.public.SessionMember
      .where({ sessionId })
      .select('userId')
      .all()) as Array<{ userId: number }>;
    return rows.map((r) => r.userId);
  }

  /** 是否为好友关系（邀请校验用，FriendsService 的表在 sessions 侧，这里直查避免循环） */
  private async areFriends(a: number, b: number): Promise<boolean> {
    const [userAId, userBId] = [Math.min(a, b), Math.max(a, b)];
    const row = await this.prisma.orm.public.Friendship.first({
      userAId,
      userBId,
      status: 'accepted',
    });
    return row !== null;
  }

  /**
   * 落一条 system 消息（成员变动/群事件），fan-out 全部成员的回实行，
   * 并广播 message:new —— 复用消息链路，全员聊天流内可见。
   */
  private async createSystemMessage(sessionId: number, content: string): Promise<void> {
    const now = new Date().toISOString();
    const message = await this.prisma.client.transaction(async (tx) => {
      const row = (await tx.orm.public.Message.create({
        sessionId,
        senderId: null,
        kind: 'system',
        content,
      })) as MessageRow;

      const members = await this.memberIds(sessionId);
      await tx.orm.public.MessageStatus.createAll(
        members.map((uid) => ({ messageId: row.id, userId: uid, sessionId })),
      );

      await tx.orm.public.Session.where({ id: sessionId }).update({
        lastMessageId: row.id,
        lastMessageAt: row.createdAt,
      });
      return row;
    });

    const chatMessage = toChatMessage(message, '');
    for (const uid of await this.memberIds(sessionId)) {
      this.ws.toUser(String(uid), 'message:new', chatMessage);
    }
  }

  private broadcastGroupUpdated(conversationId: string): void {
    this.ws.broadcast('group:updated', { conversationId });
  }

  // ── 建群 / 详情 ──────────────────────────────────────────

  /** 建群：创建者为群主，memberIds 为初始成员（须是创建者好友），并邀请好友入群 */
  async create(meId: number, name: string, memberUserIds: number[]): Promise<SessionSummary> {
    const groupName = name.trim();
    if (!groupName) throw new BadRequestException('群名称不能为空');

    const uniqueIds = [...new Set(memberUserIds)].filter((id) => id !== meId);
    for (const id of uniqueIds) {
      if (!(await this.areFriends(meId, id))) {
        throw new ForbiddenException('仅能邀请自己的好友加入群聊');
      }
    }
    if (uniqueIds.length + 1 > MAX_MEMBERS) {
      throw new BadRequestException(`群成员不能超过 ${MAX_MEMBERS} 人`);
    }

    const session = await this.prisma.client.transaction(async (tx) => {
      const row = (await tx.orm.public.Session.create({
        kind: 'group',
        name: groupName,
        userAId: null,
        userBId: null,
      })) as SessionRow;

      await tx.orm.public.SessionMember.createAll([
        { sessionId: row.id, userId: meId, role: 'owner' },
        ...uniqueIds.map((userId) => ({ sessionId: row.id, userId, role: 'member' as const })),
      ]);
      return row;
    });

    await this.createSystemMessage(session.id, `${groupName} 成立了`);

    const row = (await this.sessionRow(session.id)) as SessionRow;
    return {
      id: String(row.id),
      kind: 'group',
      name: groupName,
      memberCount: uniqueIds.length + 1,
      myRole: 'owner',
      muteAll: false,
      unreadCount: 0,
      lastMessageAt: row.lastMessageAt,
      createdAt: row.createdAt,
    };
  }

  /** 群详情：资料 + 公告 + 全部成员（含在线状态） */
  async detail(meId: number, groupId: number): Promise<GroupDetail> {
    const group = await this.assertGroup(groupId);
    const { role } = await this.myMember(groupId, meId);

    const members = (await this.prisma.orm.public.SessionMember
      .where({ sessionId: groupId })
      .all()) as Array<{ userId: number; role: Role; joinedAt: string }>;

    const items: GroupMemberItem[] = await Promise.all(
      members.map(async (m) => {
        const user = await this.publicUser(m.userId);
        return { user, role: m.role, joinedAt: m.joinedAt, online: this.ws.isOnline(String(m.userId)) };
      }),
    );
    items.sort((a, b) => {
      const order = { owner: 0, admin: 1, member: 2 } as const;
      return order[a.role] - order[b.role] || a.user.id - b.user.id;
    });

    const announcer = group.announcementById
      ? await this.prisma.orm.public.User.first({ id: group.announcementById })
      : null;

    return {
      id: String(group.id),
      name: group.name ?? '群聊',
      ...(group.avatarUrl ? { avatarUrl: group.avatarUrl } : {}),
      ...(group.announcement
        ? {
            announcement: group.announcement,
            announcementAt: group.announcementAt ?? undefined,
            announcementBy: announcer?.nickname,
          }
        : {}),
      muteAll: group.muteAll,
      myRole: role,
      members: items,
      createdAt: group.createdAt,
    };
  }

  // ── 群管理 ───────────────────────────────────────────────

  /** 邀请成员（群主/管理员；被邀请人须是操作者好友） */
  async invite(meId: number, groupId: number, userIds: number[]): Promise<void> {
    await this.assertGroup(groupId);
    await this.requireRole(groupId, meId, ['owner', 'admin']);

    const existing = new Set(await this.memberIds(groupId));
    const toAdd = [...new Set(userIds)].filter((id) => !existing.has(id));
    if (toAdd.length === 0) return;
    if (existing.size + toAdd.length > MAX_MEMBERS) {
      throw new BadRequestException(`群成员不能超过 ${MAX_MEMBERS} 人`);
    }

    const group = await this.sessionRow(groupId);
    const names: string[] = [];
    for (const id of toAdd) {
      if (!(await this.areFriends(meId, id))) {
        throw new ForbiddenException('仅能邀请自己的好友加入群聊');
      }
      names.push((await this.publicUser(id)).nickname);
      await this.prisma.orm.public.SessionMember.create({
        sessionId: groupId,
        userId: id,
        role: 'member',
      });
    }

    await this.createSystemMessage(groupId, `${names.join('、')} 加入了群聊`);
    this.broadcastGroupUpdated(String(groupId));
    void group;
  }

  /** 踢出成员：群主可踢管理员/成员；管理员仅可踢成员；不能踢自己（走退群） */
  async kick(meId: number, groupId: number, targetId: number): Promise<void> {
    await this.assertGroup(groupId);
    const myRole = await this.requireRole(groupId, meId, ['owner', 'admin']);
    if (targetId === meId) throw new BadRequestException('不能移除自己，请使用退出群聊');

    const target = await this.prisma.orm.public.SessionMember.first({
      sessionId: groupId,
      userId: targetId,
    });
    if (!target) throw new NotFoundException('该用户不是群成员');
    const targetRole = target.role as Role;
    if (targetRole === 'owner') throw new ForbiddenException('不能移除群主');
    if (myRole === 'admin' && targetRole === 'admin') {
      throw new ForbiddenException('管理员只能移除普通成员');
    }

    await this.prisma.orm.public.SessionMember.where({ sessionId: groupId, userId: targetId }).delete();
    const targetUser = await this.publicUser(targetId);
    await this.createSystemMessage(groupId, `${targetUser.nickname} 被移出了群聊`);
    this.broadcastGroupUpdated(String(groupId));
  }

  /** 转让群主（仅群主）：新群主须是现有成员，原群主降为成员 */
  async transfer(meId: number, groupId: number, toUserId: number): Promise<void> {
    await this.assertGroup(groupId);
    await this.requireRole(groupId, meId, ['owner']);
    if (toUserId === meId) throw new BadRequestException('不能转让给自己');

    const target = await this.prisma.orm.public.SessionMember.first({
      sessionId: groupId,
      userId: toUserId,
    });
    if (!target) throw new NotFoundException('对方不是群成员');

    await this.prisma.orm.public.SessionMember.where({ sessionId: groupId, userId: meId }).update({
      role: 'member',
    });
    await this.prisma.orm.public.SessionMember.where({ sessionId: groupId, userId: toUserId }).update({
      role: 'owner',
    });

    const newUser = await this.publicUser(toUserId);
    await this.createSystemMessage(groupId, `${newUser.nickname} 成为了群主`);
    this.broadcastGroupUpdated(String(groupId));
  }

  /** 退出群聊（群主需先转让）；成员/管理员直接退出 */
  async leave(meId: number, groupId: number): Promise<void> {
    await this.assertGroup(groupId);
    const { role } = await this.myMember(groupId, meId);
    if (role === 'owner') throw new BadRequestException('群主需先转让群主后再退出');

    const me = await this.publicUser(meId);
    await this.prisma.orm.public.SessionMember.where({ sessionId: groupId, userId: meId }).delete();
    await this.createSystemMessage(groupId, `${me.nickname} 退出了群聊`);
    this.broadcastGroupUpdated(String(groupId));
  }

  // ── 群资料 / 公告 / 禁言 ─────────────────────────────────

  /** 修改群名称/头像（群主/管理员） */
  async updateProfile(meId: number, groupId: number, data: { name?: string; avatarUrl?: string }): Promise<void> {
    await this.assertGroup(groupId);
    await this.requireRole(groupId, meId, ['owner', 'admin']);

    const patch: { name?: string; avatarUrl?: string } = {};
    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new BadRequestException('群名称不能为空');
      patch.name = name;
    }
    if (data.avatarUrl !== undefined) patch.avatarUrl = data.avatarUrl;
    if (Object.keys(patch).length === 0) throw new BadRequestException('没有需要更新的字段');

    await this.prisma.orm.public.Session.where({ id: groupId }).update(patch);
    this.broadcastGroupUpdated(String(groupId));
  }

  /** 发布/更新群公告（群主/管理员） */
  async setAnnouncement(meId: number, groupId: number, content: string): Promise<void> {
    await this.assertGroup(groupId);
    await this.requireRole(groupId, meId, ['owner', 'admin']);
    const text = content.trim();
    if (!text) throw new BadRequestException('公告内容不能为空');

    await this.prisma.orm.public.Session.where({ id: groupId }).update({
      announcement: text,
      announcementAt: new Date().toISOString(),
      announcementById: meId,
    });
    this.broadcastGroupUpdated(String(groupId));
  }

  /** 全员禁言开关（群主/管理员）：开启后仅群主/管理员可发言 */
  async setMuteAll(meId: number, groupId: number, muteAll: boolean): Promise<void> {
    await this.assertGroup(groupId);
    await this.requireRole(groupId, meId, ['owner', 'admin']);
    await this.prisma.orm.public.Session.where({ id: groupId }).update({ muteAll });
    this.broadcastGroupUpdated(String(groupId));
  }
}
