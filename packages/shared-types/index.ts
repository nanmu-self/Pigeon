export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
}

export interface Message {
  id: string;
  content: string;
  senderId: string;
  timestamp: number;
  encrypted: boolean;
}

export interface ApiResponse<T = unknown> {
  data: T;
  message: string;
  code: number;
}

export enum MessageType {
  Text = 'text',
  Image = 'image',
  Video = 'video',
}
