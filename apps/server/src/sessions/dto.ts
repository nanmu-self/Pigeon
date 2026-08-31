import { IsInt, IsPositive } from 'class-validator';

/** POST /sessions 入参：与哪个好友建会话（幂等） */
export class CreateSessionDto {
  @IsInt()
  @IsPositive()
  peerId!: number;
}
