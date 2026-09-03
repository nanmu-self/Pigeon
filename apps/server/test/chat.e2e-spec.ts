import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CaptchaService } from '../src/auth/captcha.service.js';
import { PrismaService } from '../src/prisma.service.js';
import { WsEventsService } from '../src/ws/ws-events.service.js';
import type {
  AuthResult,
  FriendItem,
  FriendRequestItem,
  MessageHistoryPage,
  MessageReadAck,
  PublicUser,
  SessionSummary,
  WsChatMessage,
} from '@pigeon/shared-types';
import { FakeTransportBridge, applyTransportEnv, rtAck } from './helpers/transport.js';

/**
 * 聊天链路端到端验证（传输无关，D7）：
 *   搜索用户 → 加好友（申请/通过）→ 好友列表（在线状态）→ 建会话
 *   → 发消息（对方收到 message:new）→ 未读数 → 已读回执 → 历史消息（游标分页）
 *   → 幂等重发 / 权限闸门 / 拉黑拦截。
 *
 * 实时通道不再连接 Socket.IO：WsEventsService 被替换为 FakeTransportBridge，
 * 断言「谁收到了什么推送」；C2S 走 supertest 打 /internal/rt/:type
 * （与 Rust 传输服务转发同一入口）。Socket.IO 删除（P4）时本文件零改动。
 *
 * 验证码以测试桩替换（issue 恒返回 test id，verify 只认 0000），
 * 从而走通真实注册/登录与 JWT 签发链路。
 */

const CAPTCHA_CODE = '0000';

/** REST 快捷方式 */
let api: ReturnType<typeof request>;
let prisma: PrismaService;
let bridge: FakeTransportBridge;

async function register(nickname: string): Promise<AuthResult> {
  const email = `${nickname}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.test`;
  const response = await api.post('/auth/register').send({
    email,
    password: 'Passw0rd!123',
    nickname,
    captchaId: 'test-captcha-id',
    captchaCode: CAPTCHA_CODE,
  });
  expect(response.status).toBe(201);
  return response.body as AuthResult;
}

let alice: AuthResult;
let bob: AuthResult;
let charlie: AuthResult;

describe('聊天链路 (e2e)', () => {
  beforeAll(async () => {
    applyTransportEnv();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CaptchaService)
      .useValue({
        issue: () => ({ captchaId: 'test-captcha-id', image: 'data:image/png;base64,' }),
        verify: (_id: string, code: string) => code === CAPTCHA_CODE,
      })
      // D7：传输无关 —— 记录「谁收到了什么推送」
      .overrideProvider(WsEventsService)
      .useValue(new FakeTransportBridge())
      .compile();

    const app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    app.enableShutdownHooks();
    await app.listen(0); // 随机端口，避免并发冲突
    api = request(app.getHttpServer());
    prisma = app.get(PrismaService);
    bridge = app.get(WsEventsService) as unknown as FakeTransportBridge;

    alice = await register('Alice');
    bob = await register('Bob');
    charlie = await register('Charlie');
  }, 30_000);

  beforeEach(() => {
    bridge.reset(); // 等价旧测试「每用例重连/断开」的 presence 生命周期
  });

  afterAll(async () => {
    // 测试用户级联清理：好友/会话/消息/回实行
    for (const u of [alice, bob, charlie]) {
      const id = u.user.id;
      const sessA = await prisma.orm.public.Session.where({ userAId: id }).all();
      const sessB = await prisma.orm.public.Session.where({ userBId: id }).all();
      for (const s of [...sessA, ...sessB]) {
        await prisma.orm.public.Message.where({ sessionId: s.id }).deleteAll();
        await prisma.orm.public.Session.where({ id: s.id }).delete();
      }
      await prisma.orm.public.Friendship.where({ userAId: id }).deleteAll();
      await prisma.orm.public.Friendship.where({ userBId: id }).deleteAll();
      await prisma.orm.public.User.where({ id }).delete();
    }
    await prisma.onApplicationShutdown();
  });

  it('搜索用户：昵称模糊 + 邮箱精确，且不含自己', async () => {
    const byNickname = await api
      .get(`/users/search?q=${encodeURIComponent('bob')}`)
      .auth(alice.token, { type: 'bearer' });
    expect(byNickname.status).toBe(200);
    const hit = (byNickname.body as PublicUser[]).find((u) => u.id === bob.user.id);
    expect(hit?.nickname).toBe('Bob');

    const byEmail = await api
      .get(`/users/search?q=${encodeURIComponent(bob.user.email)}`)
      .auth(alice.token, { type: 'bearer' });
    expect((byEmail.body as PublicUser[]).map((u) => u.id)).toContain(bob.user.id);

    const self = await api
      .get(`/users/search?q=alice`)
      .auth(alice.token, { type: 'bearer' });
    expect((self.body as PublicUser[]).map((u) => u.id)).not.toContain(alice.user.id);
  });

  it('加好友：申请 → 对方收到 → 通过 → 双方好友列表可见', async () => {
    // 重复申请被拒（409）
    const first = await api
      .post('/friends/requests')
      .auth(alice.token, { type: 'bearer' })
      .send({ userId: bob.user.id });
    expect(first.status).toBe(201);
    const requestId = (first.body as FriendRequestItem).id;

    const dup = await api
      .post('/friends/requests')
      .auth(alice.token, { type: 'bearer' })
      .send({ userId: bob.user.id });
    expect(dup.status).toBe(409);

    // bob 的待处理申请列表
    const inbox = await api.get('/friends/requests').auth(bob.token, { type: 'bearer' });
    expect(inbox.status).toBe(200);
    const incoming = (inbox.body as FriendRequestItem[]).find((r) => r.id === requestId);
    expect(incoming?.direction).toBe('incoming');
    expect(incoming?.user.id).toBe(alice.user.id);

    // 通过前还不是好友：建会话被闸门拦截
    const early = await api
      .post('/sessions')
      .auth(alice.token, { type: 'bearer' })
      .send({ peerId: bob.user.id });
    expect(early.status).toBe(403);

    // bob 通过 → alice 收到 friend:accepted 推送
    bridge.setOnline(alice.user.id, true);
    const acceptedNotify = bridge.waitFor<{ user: PublicUser }>({
      userId: alice.user.id,
      type: 'friend:accepted',
    });
    const accept = await api
      .post(`/friends/requests/${requestId}/accept`)
      .auth(bob.token, { type: 'bearer' });
    expect(accept.status).toBe(201);
    const notified = await acceptedNotify;
    expect(notified.user.id).toBe(bob.user.id);

    // 双方好友列表（alice 在线 → bob 视角 online: true）
    const bobFriends = await api.get('/friends').auth(bob.token, { type: 'bearer' });
    const bobList = bobFriends.body as FriendItem[];
    expect(bobList.map((f) => f.user.id)).toContain(alice.user.id);
    expect(bobList.find((f) => f.user.id === alice.user.id)?.online).toBe(true);

    const aliceFriends = await api.get('/friends').auth(alice.token, { type: 'bearer' });
    expect((aliceFriends.body as FriendItem[]).map((f) => f.user.id)).toContain(bob.user.id);
  });

  it('建会话（幂等）→ 发消息 → 对方实时收到 + 未读数', async () => {
    bridge.setOnline(alice.user.id, true);
    bridge.setOnline(bob.user.id, true);

    const created = await api
      .post('/sessions')
      .auth(alice.token, { type: 'bearer' })
      .send({ peerId: bob.user.id });
    expect(created.status).toBe(201);
    const sessionId = (created.body as SessionSummary).id;

    // 幂等：再次创建返回同一会话
    const again = await api
      .post('/sessions')
      .auth(bob.token, { type: 'bearer' })
      .send({ peerId: alice.user.id });
    expect((again.body as SessionSummary).id).toBe(sessionId);

    // 发消息：ack 带服务端 id；bob 收到 message:new；
    // bob 在线 → alice 收到 message:delivered 送达回执
    const received = bridge.waitFor<WsChatMessage>({
      userId: bob.user.id,
      type: 'message:new',
    });
    const delivered = bridge.waitFor<{ conversationId: string; lastDeliveredMessageId: string }>({
      userId: alice.user.id,
      type: 'message:delivered',
    });
    const sent = await rtAck<WsChatMessage>(api, alice, 'message:send', {
      conversationId: sessionId,
      content: '你好，Bob！',
      clientMsgId: 'e2e-msg-1',
    });
    expect(sent.ok).toBe(true);
    expect(sent.data?.senderName).toBe('Alice');
    expect(Number(sent.data?.id)).toBeGreaterThan(0);
    const firstMessage = sent.data as WsChatMessage;
    expect((await received).id).toBe(firstMessage.id);
    expect((await delivered).lastDeliveredMessageId).toBe(firstMessage.id);

    // bob 未读数 = 1；会话列表带最后一条消息预览
    const bobSessions = await api.get('/sessions').auth(bob.token, { type: 'bearer' });
    const summary = (bobSessions.body as SessionSummary[]).find((s) => s.id === sessionId);
    expect(summary?.unreadCount).toBe(1);
    expect(summary?.lastMessage?.content).toBe('你好，Bob！');
    expect(summary?.peer?.id).toBe(alice.user.id);

    // 幂等重发：同 clientMsgId → 同一条消息（不新增、不重复推送）
    const resent = await rtAck<WsChatMessage>(api, alice, 'message:send', {
      conversationId: sessionId,
      content: '你好，Bob！',
      clientMsgId: 'e2e-msg-1',
    });
    expect(resent.ok).toBe(true);
    expect(resent.data?.id).toBe(firstMessage.id);
    const messageNewCalls = bridge
      .callsOf('message:new')
      .filter((c) => (c.payload as WsChatMessage).id === firstMessage.id);
    expect(messageNewCalls, '幂等重发不重复推送').toHaveLength(1);
    const bobSessions2 = await api.get('/sessions').auth(bob.token, { type: 'bearer' });
    expect((bobSessions2.body as SessionSummary[]).find((s) => s.id === sessionId)?.unreadCount).toBe(1);

    // 图片消息：meta（七牛上传信息）随消息透传，接收方实时收到且历史可回读
    const imageReceived = bridge.waitFor<WsChatMessage>({
      userId: bob.user.id,
      type: 'message:new',
      match: (p) => (p as WsChatMessage).kind === 'image',
    });
    const imageSent = await rtAck<WsChatMessage>(api, alice, 'message:send', {
      conversationId: sessionId,
      content: 'http://localhost:7600/pigeon/chat/2026/08/abc.png',
      kind: 'image',
      meta: { fname: 'cat.png', size: 20480, mime: 'image/png' },
      clientMsgId: 'e2e-img-1',
    });
    expect(imageSent.ok).toBe(true);
    expect(imageSent.data?.kind).toBe('image');
    expect(imageSent.data?.meta).toMatchObject({ fname: 'cat.png', mime: 'image/png' });
    expect((await imageReceived).meta).toMatchObject({ fname: 'cat.png' });

    // 供后续用例复用
    (globalThis as { __e2eSessionId?: string }).__e2eSessionId = sessionId;
  });

  it('已读回执：B 标记已读 → A 收到推送 + 未读清零', async () => {
    const sessionId = (globalThis as { __e2eSessionId?: string }).__e2eSessionId;
    bridge.setOnline(alice.user.id, true);
    bridge.setOnline(bob.user.id, true);

    const receipt = bridge.waitFor<{ conversationId: string; userId: string; lastReadMessageId: string }>({
      userId: alice.user.id,
      type: 'message:read',
    });
    const readAck = await rtAck<MessageReadAck>(api, bob, 'message:read', { conversationId: sessionId });
    expect(readAck.ok).toBe(true);
    expect(Number(readAck.data?.lastReadMessageId)).toBeGreaterThan(0);

    const got = await receipt;
    expect(got.conversationId).toBe(sessionId);
    expect(got.userId).toBe(String(bob.user.id));
    expect(got.lastReadMessageId).toBe(readAck.data?.lastReadMessageId);

    // 历史接口带出对端水位（alice 视角：bob 已读到最新一条）
    const history = await api
      .get(`/sessions/${sessionId}/messages?limit=1`)
      .auth(alice.token, { type: 'bearer' });
    const page = history.body as MessageHistoryPage;
    expect(page.peerReadUpTo).toBe(readAck.data?.lastReadMessageId);
    expect(page.peerDeliveredUpTo).toBe(readAck.data?.lastReadMessageId); // 已读回填送达

    // 未读清零；REST 已读接口同样可用（幂等）
    const bobSessions = await api.get('/sessions').auth(bob.token, { type: 'bearer' });
    expect((bobSessions.body as SessionSummary[]).find((s) => s.id === sessionId)?.unreadCount).toBe(0);
    const restRead = await api.post(`/sessions/${sessionId}/read`).auth(bob.token, { type: 'bearer' });
    expect((restRead.body as MessageReadAck).conversationId).toBe(sessionId);

    // lastReadAt 锚点已更新到 bob 所属一侧
    const sessRow = (await prisma.orm.public.Session.first({ id: Number(sessionId) })) as {
      userAId: number;
      userBId: number;
      lastReadAtA: string | null;
      lastReadAtB: string | null;
    } | null;
    const bobLastRead = sessRow!.userAId === bob.user.id ? sessRow!.lastReadAtA : sessRow!.lastReadAtB;
    expect(bobLastRead).not.toBeNull();
  });

  it('历史消息：正序返回 + 游标分页', async () => {
    const sessionId = (globalThis as { __e2eSessionId?: string }).__e2eSessionId;
    bridge.setOnline(alice.user.id, true);

    // 再发 4 条（合计 5 条）
    for (let i = 2; i <= 5; i++) {
      const r = await rtAck<WsChatMessage>(api, alice, 'message:send', {
        conversationId: sessionId,
        content: `消息 ${i}`,
        clientMsgId: `e2e-msg-${i}`,
      });
      expect(r.ok).toBe(true);
    }

    const page1 = await api
      .get(`/sessions/${sessionId}/messages?limit=3`)
      .auth(bob.token, { type: 'bearer' });
    expect(page1.status).toBe(200);
    const p1 = page1.body as MessageHistoryPage;
    expect(p1.messages).toHaveLength(3);
    // 第一页 = 最新 3 条（打开聊天先看最新消息），页内按时间正序
    expect(p1.messages.map((m) => m.content)).toEqual(['消息 3', '消息 4', '消息 5']);
    expect(p1.hasMore).toBe(true);

    // 用本页最早一条的 id 作游标往前翻（共 6 条：你好Bob + 图片 + 消息2..5）
    const cursor = p1.messages[0].id;
    const page2 = await api
      .get(`/sessions/${sessionId}/messages?limit=3&cursor=${cursor}`)
      .auth(bob.token, { type: 'bearer' });
    const p2 = page2.body as MessageHistoryPage;
    expect(p2.messages.map((m) => m.content)).toEqual([
      '你好，Bob！',
      'http://localhost:7600/pigeon/chat/2026/08/abc.png',
      '消息 2',
    ]);
    expect(p2.messages.find((m) => m.kind === 'image')?.meta).toMatchObject({ fname: 'cat.png' });
    expect(p2.hasMore).toBe(false);
  });

  it('内部端点防线：无内部令牌的 /internal/rt 调用被拒绝', async () => {
    const sessionId = (globalThis as { __e2eSessionId?: string }).__e2eSessionId;
    const noToken = await api.post('/internal/rt/message:send').send({
      conversationId: sessionId,
      content: '越权',
    });
    expect([401, 403]).toContain(noToken.status);
    const badToken = await api
      .post('/internal/rt/message:send')
      .set('x-internal-token', 'wrong-token')
      .set('x-user-id', String(alice.user.id))
      .send({ conversationId: sessionId, content: '越权' });
    expect([401, 403]).toContain(badToken.status);
  });

  it('权限闸门：非好友不能建会话，非成员不能读历史/发消息', async () => {
    // charlie（与 alice/bob 无关系）不能建会话
    const noFriend = await api
      .post('/sessions')
      .auth(charlie.token, { type: 'bearer' })
      .send({ peerId: alice.user.id });
    expect(noFriend.status).toBe(403);

    // charlie 不能读 alice-bob 的会话历史，也不能标记已读
    const sessionId = (globalThis as { __e2eSessionId?: string }).__e2eSessionId;
    const history = await api.get(`/sessions/${sessionId}/messages`).auth(charlie.token, { type: 'bearer' });
    expect(history.status).toBe(403);
    const read = await api.post(`/sessions/${sessionId}/read`).auth(charlie.token, { type: 'bearer' });
    expect(read.status).toBe(403);

    // charlie 也发不了消息到该会话（非成员；C2S 走 /internal/rt 与网关同口径）
    const send = await rtAck<WsChatMessage>(api, charlie, 'message:send', {
      conversationId: sessionId,
      content: '骚扰',
    });
    expect(send.ok).toBe(false);
  });

  it('拉黑拦截：拉黑后对方发消息被拒，解除后恢复', async () => {
    const sessionId = (globalThis as { __e2eSessionId?: string }).__e2eSessionId;
    bridge.setOnline(alice.user.id, true);
    bridge.setOnline(bob.user.id, true);

    // alice 拉黑 bob
    const block = await api
      .post(`/friends/${bob.user.id}/block`)
      .auth(alice.token, { type: 'bearer' });
    expect(block.status).toBe(204);

    // bob 给 alice 发消息 → 被好友闸门拦截
    const blocked = await rtAck<WsChatMessage>(api, bob, 'message:send', {
      conversationId: sessionId,
      content: '还能发吗',
    });
    expect(blocked.ok).toBe(false);

    // bob 反向建会话也被拦（同一闸门）
    const newSession = await api
      .post('/sessions')
      .auth(bob.token, { type: 'bearer' })
      .send({ peerId: alice.user.id });
    expect(newSession.status).toBe(403);

    // alice 解除拉黑 → 曾是好友（acceptedAt 非空）→ 恢复 accepted
    const unblock = await api
      .post(`/friends/${bob.user.id}/unblock`)
      .auth(alice.token, { type: 'bearer' });
    expect(unblock.status).toBe(204);

    const okAgain = await rtAck<WsChatMessage>(api, bob, 'message:send', {
      conversationId: sessionId,
      content: '又通了',
      clientMsgId: 'e2e-msg-6',
    });
    expect(okAgain.ok).toBe(true);
  });

  it('引用回复 + 表情回应', async () => {
    const sessionId = (globalThis as { __e2eSessionId?: string }).__e2eSessionId;
    bridge.setOnline(alice.user.id, true);
    bridge.setOnline(bob.user.id, true);

    // 1. bob 引用回复 alice 的第一条消息（服务端校验同会话 + 内嵌摘要）
    const history0 = await api
      .get(`/sessions/${sessionId}/messages?limit=1`)
      .auth(bob.token, { type: 'bearer' });
    const firstMsgId = (history0.body as MessageHistoryPage).messages[0].id;

    const replyReceived = bridge.waitFor<WsChatMessage>({
      userId: alice.user.id,
      type: 'message:new',
      match: (p) => (p as WsChatMessage).replyTo?.id === firstMsgId,
    });
    const reply = await rtAck<WsChatMessage>(api, bob, 'message:send', {
      conversationId: sessionId,
      content: '收到！',
      replyToId: firstMsgId,
      clientMsgId: 'e2e-reply-1',
    });
    expect(reply.ok).toBe(true);
    expect(reply.data?.replyTo?.id).toBe(firstMsgId);
    expect(reply.data?.replyTo?.senderName).toBe('Bob');
    expect((await replyReceived).replyTo?.id).toBe(firstMsgId);

    // 2. alice 对 bob 的回复点 👍；重复添加幂等；bob 实时收到 reaction:update
    const reactionUpdate = bridge.waitFor<{ messageId: string; emoji: string; action: string; userId: string }>({
      userId: bob.user.id,
      type: 'reaction:update',
      match: (p) => (p as { messageId: string }).messageId === reply.data?.id,
    });
    const add1 = await rtAck<null>(api, alice, 'reaction:add', {
      conversationId: sessionId,
      messageId: reply.data?.id,
      emoji: '👍',
    });
    expect(add1.ok).toBe(true);
    const add2 = await rtAck<null>(api, alice, 'reaction:add', {
      conversationId: sessionId,
      messageId: reply.data?.id,
      emoji: '👍',
    });
    expect(add2.ok).toBe(true); // 幂等
    const upd = await reactionUpdate;
    expect(upd).toMatchObject({
      messageId: reply.data?.id,
      emoji: '👍',
      userId: String(alice.user.id),
      action: 'add',
    });

    // 3. 历史回读：回复消息带 replyTo + reactions 聚合
    const history = await api
      .get(`/sessions/${sessionId}/messages?limit=5`)
      .auth(bob.token, { type: 'bearer' });
    const replied = (history.body as MessageHistoryPage).messages.find(
      (m) => m.id === reply.data?.id,
    );
    expect(replied?.replyTo?.id).toBe(firstMsgId);
    expect(replied?.reactions).toEqual([
      { emoji: '👍', count: 1, userIds: [String(alice.user.id)] },
    ]);

    // 4. 取消回应 → 增量 remove
    const removeUpdate = bridge.waitFor<{ action: string }>({
      userId: bob.user.id,
      type: 'reaction:update',
      match: (p) => (p as { action: string }).action === 'remove',
    });
    const remove = await rtAck<null>(api, alice, 'reaction:remove', {
      conversationId: sessionId,
      messageId: reply.data?.id,
      emoji: '👍',
    });
    expect(remove.ok).toBe(true);
    expect((await removeUpdate).action).toBe('remove');

    // 5. 非成员不能回应
    const stranger = await rtAck<null>(api, charlie, 'reaction:add', {
      conversationId: sessionId,
      messageId: reply.data?.id,
      emoji: '👍',
    });
    expect(stranger.ok).toBe(false);

    // 6. 跨会话引用被拒（charlie 对 bob 无会话，直接用 bob 的会话 id 引不存在的消息）
    const badReply = await rtAck<WsChatMessage>(api, bob, 'message:send', {
      conversationId: sessionId,
      content: '跨会话引用',
      replyToId: '999999',
    });
    expect(badReply.ok).toBe(false);
  });

  it('消息撤回：2 分钟窗口内仅发送者可撤回，双端同步清空内容', async () => {
    const sessionId = (globalThis as { __e2eSessionId?: string }).__e2eSessionId;
    bridge.setOnline(alice.user.id, true);
    bridge.setOnline(bob.user.id, true);

    // alice 发两条消息
    const sent1 = await rtAck<WsChatMessage>(api, alice, 'message:send', {
      conversationId: sessionId,
      content: '会撤回的话',
      clientMsgId: 'e2e-recall-1',
    });
    expect(sent1.ok).toBe(true);
    const sent2 = await rtAck<WsChatMessage>(api, alice, 'message:send', {
      conversationId: sessionId,
      content: '不会撤回的话',
      clientMsgId: 'e2e-recall-2',
    });
    expect(sent2.ok).toBe(true);
    const msg1 = sent1.data as WsChatMessage;

    // bob 收到 alice 的撤回通知
    const notice = bridge.waitFor<{ messageId: string; userId: string }>({
      userId: bob.user.id,
      type: 'message:recalled',
      match: (p) => (p as { messageId: string }).messageId === msg1.id,
    });
    const recalled = await api
      .post(`/sessions/${sessionId}/messages/${msg1.id}/recall`)
      .auth(alice.token, { type: 'bearer' });
    expect(recalled.status).toBe(201);
    expect((await notice).messageId).toBe(msg1.id);

    // 历史回读：content 已清空 + recalledAt 标记
    const page = await api
      .get(`/sessions/${sessionId}/messages?limit=50`)
      .auth(bob.token, { type: 'bearer' });
    const recalledRow = (page.body as MessageHistoryPage).messages.find((m) => m.id === msg1.id);
    expect(recalledRow?.recalledAt).toBeGreaterThan(0);
    expect(recalledRow?.content).toBe('');

    // bob 不能撤回 alice 的消息（403）
    const notMine = await api
      .post(`/sessions/${sessionId}/messages/${sent2.data?.id}/recall`)
      .auth(bob.token, { type: 'bearer' });
    expect(notMine.status).toBe(403);

    // 超窗：直接改库把 created_at 拨到 10 分钟前 → 撤回被拒（400）
    const oldMsg = await rtAck<WsChatMessage>(api, alice, 'message:send', {
      conversationId: sessionId,
      content: '超窗消息',
      clientMsgId: 'e2e-recall-3',
    });
    expect(oldMsg.ok).toBe(true);
    const oldId = Number((oldMsg.data as WsChatMessage).id);
    await prisma.orm.public.Message
      .where({ id: oldId })
      .update({ createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    const tooLate = await api
      .post(`/sessions/${sessionId}/messages/${oldId}/recall`)
      .auth(alice.token, { type: 'bearer' });
    expect(tooLate.status).toBe(400);

    // 幂等：重复撤回同一消息 → 仍成功
    const again = await api
      .post(`/sessions/${sessionId}/messages/${msg1.id}/recall`)
      .auth(alice.token, { type: 'bearer' });
    expect(again.status).toBe(201);
  });
});
