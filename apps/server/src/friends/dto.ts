import { IsInt, IsPositive } from 'class-validator';

/** POST /friends/requests 入参：向谁发起好友申请 */
export class SendFriendRequestDto {
  @IsInt()
  @IsPositive()
  userId!: number;
}
