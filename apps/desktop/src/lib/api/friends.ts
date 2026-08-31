/**
 * 好友关系 API（/friends/*）。全部接口需要登录（JWT）。
 */
import type {
  FriendItem,
  FriendRequestItem,
  PublicUser,
} from '@pigeon/shared-types';
import { http } from './http';

export const friendsApi = {
  /** 好友列表（含在线状态，按成为好友时间倒序） */
  list: () => http.Get<FriendItem[]>('/friends'),

  /** 待处理申请（incoming = 等我处理；outgoing = 等对方处理） */
  requests: () => http.Get<FriendRequestItem[]>('/friends/requests'),

  /** 发起好友申请 */
  sendRequest: (userId: number) =>
    http.Post<FriendRequestItem>('/friends/requests', { userId }),

  /** 通过申请（仅被申请方） */
  accept: (requestId: number) =>
    http.Post<FriendItem>(`/friends/requests/${requestId}/accept`),

  /** 拒绝申请（删行，对方可再次申请） */
  decline: (requestId: number) =>
    http.Post<null>(`/friends/requests/${requestId}/decline`),

  /** 删除好友 */
  remove: (userId: number) => http.Delete<null>(`/friends/${userId}`),

  block: (userId: number) => http.Post<null>(`/friends/${userId}/block`),
  unblock: (userId: number) => http.Post<null>(`/friends/${userId}/unblock`),
};

export type { FriendItem, FriendRequestItem, PublicUser };
