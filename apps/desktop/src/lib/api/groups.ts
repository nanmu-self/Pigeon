/**
 * 群聊 API（/groups/*）。全部接口需要登录（JWT）。
 */
import type { GroupDetail, CreateGroupInput, SessionSummary } from '@pigeon/shared-types';
import { http } from './http';

export const groupsApi = {
  /** 建群（创建者为群主，memberIds 为初始成员，须是创建者好友） */
  create: (data: CreateGroupInput) => http.Post<SessionSummary>('/groups', data),

  /** 群详情：资料 + 公告 + 全部成员（含角色与在线状态） */
  detail: (groupId: string) => http.Get<GroupDetail>(`/groups/${groupId}`),

  /** 改群名/头像（群主/管理员） */
  updateProfile: (groupId: string, data: { name?: string; avatarUrl?: string }) =>
    http.Patch<null>(`/groups/${groupId}`, data),

  /** 发布/更新群公告（群主/管理员） */
  setAnnouncement: (groupId: string, content: string) =>
    http.Put<null>(`/groups/${groupId}/announcement`, { content }),

  /** 全员禁言开关（群主/管理员）：开启后仅群主/管理员可发言 */
  setMuteAll: (groupId: string, muteAll: boolean) =>
    http.Put<null>(`/groups/${groupId}/mute`, { muteAll }),

  /** 邀请成员（群主/管理员；被邀请人须是操作者好友） */
  invite: (groupId: string, userIds: number[]) =>
    http.Post<null>(`/groups/${groupId}/members`, { userIds }),

  /** 踢出成员（群主可踢管理员/成员；管理员仅可踢成员） */
  kick: (groupId: string, userId: number) =>
    http.Delete<null>(`/groups/${groupId}/members/${userId}`),

  /** 转让群主（仅群主；原群主降为成员） */
  transferOwner: (groupId: string, toUserId: number) =>
    http.Post<null>(`/groups/${groupId}/members/${toUserId}/transfer`),

  /** 退出群聊（群主需先转让群主） */
  leave: (groupId: string) => http.Post<null>(`/groups/${groupId}/leave`),
};

export type { GroupDetail };
