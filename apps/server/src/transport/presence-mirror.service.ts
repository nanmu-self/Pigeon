import { Injectable, Logger } from '@nestjs/common';
import { resolveTransportSettings } from './config.js';

/**
 * presence 镜像（决策 D6 的落地）—— Nest 侧本地内存 Map，
 * 数据来源从自己的网关换成 Rust 推送：
 *
 *  入口 1（启动 / epoch 变化 / 30s 对账）：GET {TRANSPORT}/internal/presence/snapshot
 *         → {epoch, seq, userIds[]} → 整体替换 Map
 *  入口 2（实时）：POST /internal/presence/delta {epoch, seq, userId, online, at}
 *         → epoch 变化 → 丢弃并拉 snapshot（Rust 重启了）
 *         → seq <= lastSeq → 丢弃（重复/乱序）
 *         → 正常 → 更新 Map（broadcast 由控制器执行，保持与镜像更新解耦）
 *
 * ⚠️ epoch 不可省：Rust 重启后不重建镜像会留下一批永远「在线」的幽灵用户，
 * message:delivered 判定跟着一起错。Transport 不可达时镜像保持上次状态
 * （清空会造成大面积「假离线」），打 WARN 等 30s 对账自愈。
 */
@Injectable()
export class PresenceMirrorService {
  private readonly logger = new Logger(PresenceMirrorService.name);

  /** 在线用户集合（userId → true） */
  private readonly online = new Map<string, true>();
  /** Rust 进程标识：变化 = Rust 重启 = 镜像重建 */
  private epoch: string | null = null;
  /** 已应用的最大 delta seq（单调；用于丢弃重复/乱序） */
  private lastSeq = 0;
  /** 观测计数 */
  reconcileDiffTotal = 0;
  epochRebuildTotal = 0;

  /** 启动即拉一次全量 + 开 30s 对账循环（WebTransport 是唯一实时通道） */
  onApplicationBootstrap(): void {
    void this.refreshSnapshot();
    this.startReconcileLoop();
  }

  /** 每 30s 全量对账（入口 1 的兜底路径；防 delta 丢包漂移） */
  private startReconcileLoop(intervalMs = 30_000): void {
    const tick = async (): Promise<void> => {
      const before = this.snapshotUserIds();
      const ok = await this.refreshSnapshot();
      if (ok) {
        const after = this.snapshotUserIds();
        const diff = symmetricDiffCount(before, after);
        if (diff > 0) {
          this.reconcileDiffTotal += diff;
          this.logger.warn(`presence 对账发现 ${diff} 处漂移并已修正`);
        }
      } else {
        // 镜像保持上次状态：清空会造成大面积「假离线」
        this.logger.warn('transport presence snapshot 不可达，保留上次镜像');
      }
    };
    void tick();
    setInterval(() => void tick(), intervalMs).unref?.();
  }

  /** 应用一条 delta（入口 2）。返回是否生效（控制器据它决定是否广播） */
  applyDelta(delta: { epoch: string; seq: number; userId: string; online: boolean }): 'applied' | 'stale' | 'epoch-reset' {
    if (this.epoch !== null && delta.epoch !== this.epoch) {
      // Rust 重启了：丢弃该 delta，立即重建（异步拉取，下一次查询即正确）
      this.logger.warn(`presence epoch 变化 ${this.epoch} → ${delta.epoch}，重建镜像`);
      this.epoch = null;
      this.lastSeq = 0;
      void this.refreshSnapshot();
      return 'epoch-reset';
    }
    if (delta.seq <= this.lastSeq) return 'stale'; // 重复/乱序
    if (this.epoch === null) {
      // 首条 delta（Nest 刚启动 / 快照不可用时的兜底）：采纳 epoch 并异步拉全量，
      // 避免在快照到达前把 delta 全部判 stale
      this.epoch = delta.epoch;
      void this.refreshSnapshot();
    }
    this.lastSeq = delta.seq;
    if (delta.online) this.online.set(delta.userId, true);
    else this.online.delete(delta.userId);
    return 'applied';
  }

  /** 由 internal-presence 控制器在 epoch-reset 时同步重建（保证当次语义正确） */
  async rebuildFromSnapshot(): Promise<void> {
    this.epoch = null;
    this.lastSeq = 0;
    await this.refreshSnapshot();
  }

  /**
   * 拉取全量快照整体替换镜像。成功返回 true；transport 不可达返回 false
   * 并保留现有镜像（不清空）。
   */
  async refreshSnapshot(): Promise<boolean> {
    const settings = resolveTransportSettings();
    if (!settings.internalToken) return false; // 未配置内部令牌 = 防线未就绪，无快照来源
    try {
      const response = await fetch(`${settings.internalUrl}/internal/presence/snapshot`, {
        headers: { 'x-internal-token': settings.internalToken },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`transport returned ${response.status}`);
      const body = (await response.json()) as { epoch: string; seq: number; userIds: string[] };
      const changed = this.epoch !== body.epoch;
      if (changed) this.epochRebuildTotal += 1;
      this.epoch = body.epoch;
      this.lastSeq = Math.max(this.lastSeq, body.seq ?? 0);
      this.online.clear();
      for (const userId of body.userIds ?? []) this.online.set(userId, true);
      return true;
    } catch (error) {
      this.logger.warn(`presence snapshot 拉取失败（保留上次镜像）: ${String(error)}`);
      return false;
    }
  }

  // ── 查询（同步、零延迟） ────────────────────────────────────

  isOnline(userId: string): boolean {
    return this.online.has(userId);
  }

  get size(): number {
    return this.online.size;
  }

  /** 当前 epoch（测试/观测用） */
  get currentEpoch(): string | null {
    return this.epoch;
  }

  /** 兜底入口：REST 侧少量场景需要显式标记在线（如 e2e fake）；生产链路不走这里 */
  markLocalOnline(userId: string): boolean {
    const first = !this.online.has(userId);
    this.online.set(userId, true);
    return first;
  }

  markLocalOffline(userId: string): boolean {
    return this.online.delete(userId);
  }

  private snapshotUserIds(): string[] {
    return [...this.online.keys()].sort();
  }
}

function symmetricDiffCount(a: string[], b: string[]): number {
  const setB = new Set(b);
  const setA = new Set(a);
  let diff = 0;
  for (const v of a) if (!setB.has(v)) diff += 1;
  for (const v of b) if (!setA.has(v)) diff += 1;
  return diff;
}
