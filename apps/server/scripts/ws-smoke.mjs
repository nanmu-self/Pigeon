/**
 * WS 冒烟测试：两个客户端连上 NestJS Socket.IO 网关，
 * 验证握手、房间、ack、广播、typing、探活。
 * 用法: node scripts/ws-smoke.mjs [port]
 */
import { io } from 'socket.io-client';

const PORT = process.argv[2] ?? 3048;
const URL = `http://localhost:${PORT}`;
const log = (...a) => console.log('  ✓', ...a);
const fail = (msg) => { console.error('  ✗', msg); process.exitCode = 1; };

const a = io(URL, { transports: ['websocket'], auth: { token: 'smoke-token-a' } });
const b = io(URL, { transports: ['websocket'], auth: { token: 'smoke-token-b' } });

const seen = { aWelcome: null, bWelcome: null, bNew: null, aTyping: null, aPresence: [] };

a.on('connection:welcome', (p) => (seen.aWelcome = p));
b.on('connection:welcome', (p) => (seen.bWelcome = p));
a.on('presence:update', (p) => seen.aPresence.push(p));
a.on('typing:update', (p) => (seen.aTyping = p));
b.on('message:new', (p) => (seen.bNew = p));

await Promise.all([
  new Promise((r) => a.on('connect', r)),
  new Promise((r) => b.on('connect', r)),
]);
log('two clients connected:', a.id, b.id);

// ack 探活
const ping = await a.emitWithAck('health:ping');
ping.ok ? log(`health:ping ack → online=${ping.data.online}, rtt ok`) : fail('ping not ok');
if (ping.data.online < 2) fail(`expect online>=2, got ${ping.data.online}`);

// 房间加入 + 广播
const join = await a.emitWithAck('conversation:join', 'conv-42');
join.ok ? log(`conversation:join ack → joined=${JSON.stringify(join.data.joined)}`) : fail('join failed');
await b.emitWithAck('conversation:join', 'conv-42');

const send = await b.emitWithAck('message:send', { conversationId: 'conv-42', content: 'hello from b' });
send.ok ? log(`message:send ack → id=${send.data.id}, sender=${send.data.senderId}`) : fail('send failed');

// b 收不到自己房间的重复 ack 消息之外，a 应收到 message:new 广播
await new Promise((r) => {
  const t = setTimeout(() => fail('a did not receive message:new'), 2000);
  a.on('message:new', (m) => { if (m.id === send.data.id) { clearTimeout(t); r(); } });
});
log('a received message:new broadcast');

// typing 转发（不含发送者本人）
b.emit('typing:start', { conversationId: 'conv-42', displayName: 'B' });
await new Promise((r) => {
  const t = setTimeout(() => fail('a did not receive typing:update'), 2000);
  a.on('typing:update', (p) => { if (p.typing) { clearTimeout(t); r(); } });
});
log('a received typing:update relayed from b');

// presence：b 断开后 a 收到 offline
b.disconnect();
await new Promise((r) => {
  const t = setTimeout(() => fail('a did not receive presence offline'), 2000);
  a.on('presence:update', (p) => {
    if (!p.online && p.userId === seen.bWelcome?.userId) { clearTimeout(t); r(); }
  });
});
log(`a received presence:update offline for b (${seen.bWelcome?.userId})`);

// HTTP /health（alova 将请求的端点）
const res = await fetch(`${URL}/health`);
const health = await res.json();
res.ok && health.status === 'ok'
  ? log(`GET /health → ${JSON.stringify(health)}`)
  : fail('health endpoint broken');

a.disconnect();
console.log(process.exitCode ? '\nSMOKE FAILED' : '\nSMOKE PASSED');
