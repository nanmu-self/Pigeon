//! 连接注册表：userId → 连接集合 + presence 权威状态（epoch/seq）。
//!
//! ⚠️ 单实例假设（决策 D8）：registry 在**进程内存**，传输服务不可多副本。
//! 未来要多副本需要 Redis pub/sub 或按 userId 一致性哈希路由；
//! 在此之前加副本 = 一半用户收不到推送。

use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use tokio::sync::mpsc;

use crate::proto::PushFrame;

/// 每连接的推送队列容量。按「每连接 ~20 msg/s × 铺垫 10s」估算；
/// 满了**不允许静默丢帧**（见 conn.rs 的背压处理：resync → close）。
pub const PUSH_QUEUE_CAPACITY: usize = 512;

/// 一路已鉴权连接的句柄（注册表持有，推送入口）
#[derive(Debug, Clone)]
pub struct ConnHandle {
    pub conn_id: String,
    pub remote_ip: IpAddr,
    /// 推送入口：发送 PushFrame 到该连接的写循环
    pub tx: mpsc::Sender<PushFrame>,
}

pub struct Registry {
    /// Rust 进程启动时间戳 —— Rust 重启后变化，Nest 据此重建 presence 镜像
    epoch: String,
    seq: AtomicU64,
    conns: DashMap<String, Vec<ConnHandle>>,
    /// 每 IP 并发连接数（滥用防护；accept 时检查，hello 前生效）
    per_ip: DashMap<IpAddr, u64>,
    max_conn_per_ip: usize,
    max_conn_per_user: usize,
}

fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

impl Registry {
    pub fn new(max_conn_per_ip: usize, max_conn_per_user: usize) -> Self {
        Self {
            epoch: format!("{}-{}", now_millis(), uuid_like()),
            seq: AtomicU64::new(0),
            conns: DashMap::new(),
            per_ip: DashMap::new(),
            max_conn_per_ip,
            max_conn_per_user,
        }
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    /// 当前全局 seq（presence 快照用；单调递增，Nest 据此丢弃重复/乱序 delta）
    pub fn seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    pub fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// try_acquire IP 名额（hello 鉴权前调用，拒绝在最便宜的时刻发生）
    pub fn try_acquire_ip(&self, ip: IpAddr) -> bool {
        match self.per_ip.entry(ip) {
            dashmap::mapref::entry::Entry::Occupied(mut e) => {
                if *e.get() >= self.max_conn_per_ip as u64 {
                    return false;
                }
                *e.get_mut() += 1;
                true
            }
            dashmap::mapref::entry::Entry::Vacant(e) => {
                e.insert(1);
                true
            }
        }
    }

    pub fn release_ip(&self, ip: IpAddr) {
        if let Some(mut count) = self.per_ip.get_mut(&ip) {
            *count -= 1;
            if *count == 0 {
                drop(count);
                self.per_ip.remove(&ip);
            }
        }
    }

    /// 注册一路连接。返回 (是否该用户首路连接, 是否超过单用户连接上限)。
    pub fn insert(&self, user_id: &str, handle: ConnHandle) -> (bool, bool) {
        let mut entry = self.conns.entry(user_id.to_string()).or_default();
        if entry.len() >= self.max_conn_per_user {
            return (false, true);
        }
        let first = entry.is_empty();
        entry.push(handle);
        (first, false)
    }

    /// 注销一路连接。返回是否该用户的最后一路（用于 presence 离线 delta）。
    pub fn remove(&self, user_id: &str, conn_id: &str) -> bool {
        let mut last = false;
        if let Some(mut entry) = self.conns.get_mut(user_id) {
            entry.retain(|h| h.conn_id != conn_id);
            last = entry.is_empty();
        }
        if last {
            self.conns.remove(user_id);
        }
        last
    }

    /// 在线用户数（去重；口径 = 用户，不是连接数）
    pub fn online_user_count(&self) -> usize {
        self.conns.len()
    }

    /// 在线连接数
    pub fn connection_count(&self) -> usize {
        self.conns.iter().map(|e| e.value().len()).sum()
    }

    /// presence 快照（Nest 每 30s 拉取对账）
    pub fn snapshot(&self) -> crate::proto::PresenceSnapshot {
        crate::proto::PresenceSnapshot {
            epoch: self.epoch.clone(),
            seq: self.seq(),
            user_ids: self.conns.iter().map(|e| e.key().clone()).collect(),
        }
    }

    /// 定向投递：对每个目标的每路连接入队。返回成功入队的连接数。
    pub async fn publish_to_users(&self, user_ids: &[String], frame: PushFrame) -> usize {
        let mut delivered = 0;
        for uid in user_ids {
            delivered += self.publish_to_user(uid, frame.clone()).await;
        }
        delivered
    }

    /// 投递给单个用户的全部连接（try_send：满队列由写循环按背压策略处理，
    /// 不阻塞内部 HTTP —— Nest 的业务事务不能被慢连接拖住）
    pub async fn publish_to_user(&self, user_id: &str, frame: PushFrame) -> usize {
        let handles = match self.conns.get(user_id) {
            Some(list) => list.clone(),
            None => return 0,
        };
        let mut delivered = 0;
        for handle in handles {
            if handle.tx.try_send(frame.clone()).is_ok() {
                delivered += 1;
            }
        }
        delivered
    }

    /// 全服广播（presence:update / group:updated）
    pub async fn broadcast(&self, frame: PushFrame) -> usize {
        let mut delivered = 0;
        for entry in self.conns.iter() {
            for handle in entry.value() {
                if handle.tx.try_send(frame.clone()).is_ok() {
                    delivered += 1;
                }
            }
        }
        delivered
    }

    /// 优雅关闭：给所有连接推 going_away（客户端立即重连，而不是等 idle timeout）
    pub async fn going_away(&self, seq_start: u64) {
        let mut seq = seq_start;
        for entry in self.conns.iter() {
            for handle in entry.value() {
                seq += 1;
                let _ = handle.tx.try_send(PushFrame::control(seq, "going_away", "server shutting down"));
            }
        }
    }
}

/// 轻量随机后缀（避免同毫秒重启 epoch 撞车）；无需完整 UUID
fn uuid_like() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 8];
    rand::rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle(conn_id: &str) -> ConnHandle {
        let (tx, _rx) = mpsc::channel(PUSH_QUEUE_CAPACITY);
        ConnHandle { conn_id: conn_id.to_string(), remote_ip: "127.0.0.1".parse().unwrap(), tx }
    }

    #[tokio::test]
    async fn insert_remove_lifecycle() {
        let reg = Registry::new(20, 8);
        let (first, over) = reg.insert("1", handle("c1"));
        assert!(first && !over);
        let (first2, _) = reg.insert("1", handle("c2"));
        assert!(!first2, "第二路连接不算首连");
        assert_eq!(reg.online_user_count(), 1);
        assert_eq!(reg.connection_count(), 2);

        assert!(!reg.remove("1", "c1"), "还有一路");
        assert!(reg.remove("1", "c2"), "末路");
        assert_eq!(reg.online_user_count(), 0);
    }

    #[tokio::test]
    async fn per_user_connection_limit() {
        let reg = Registry::new(20, 2);
        assert!(!reg.insert("1", handle("c1")).1);
        assert!(!reg.insert("1", handle("c2")).1);
        let (_, over) = reg.insert("1", handle("c3"));
        assert!(over, "超过单用户上限");
    }

    #[tokio::test]
    async fn per_ip_limit() {
        let reg = Registry::new(2, 8);
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        assert!(reg.try_acquire_ip(ip));
        assert!(reg.try_acquire_ip(ip));
        assert!(!reg.try_acquire_ip(ip), "超过单 IP 上限");
        reg.release_ip(ip);
        assert!(reg.try_acquire_ip(ip));
    }

    #[tokio::test]
    async fn publish_reaches_all_conns() {
        let reg = Registry::new(20, 8);
        let (tx1, mut rx1) = mpsc::channel(PUSH_QUEUE_CAPACITY);
        let (tx2, mut rx2) = mpsc::channel(PUSH_QUEUE_CAPACITY);
        let (tx3, mut rx3) = mpsc::channel(PUSH_QUEUE_CAPACITY);
        reg.insert("1", ConnHandle { conn_id: "c1".into(), remote_ip: "127.0.0.1".parse().unwrap(), tx: tx1 });
        reg.insert("1", ConnHandle { conn_id: "c2".into(), remote_ip: "127.0.0.1".parse().unwrap(), tx: tx2 });
        reg.insert("2", ConnHandle { conn_id: "c3".into(), remote_ip: "127.0.0.1".parse().unwrap(), tx: tx3 });

        let n = reg.publish_to_users(&["1".into()], PushFrame::event(1, "message:new", serde_json::json!({}))).await;
        assert_eq!(n, 2);
        assert!(rx1.try_recv().is_ok());
        assert!(rx2.try_recv().is_ok());

        let n = reg.broadcast(PushFrame::event(2, "presence:update", serde_json::json!({}))).await;
        assert_eq!(n, 3);
        assert!(rx3.try_recv().is_ok());
    }

    #[tokio::test]
    async fn snapshot_lists_online_users() {
        let reg = Registry::new(20, 8);
        reg.insert("1", handle("c1"));
        reg.insert("2", handle("c2"));
        let snap = reg.snapshot();
        assert_eq!(snap.epoch, reg.epoch());
        let mut ids = snap.user_ids;
        ids.sort();
        assert_eq!(ids, vec!["1".to_string(), "2".to_string()]);
    }
}
