import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

/**
 * PATCH /users/me 入参（部分更新：只传需要改的字段）。
 * 两个字段都缺省时服务端返回 400。
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(2, 32, { message: '昵称长度需在 2~32 个字符' })
  nickname?: string;

  /** 头像外链，必须来自七牛直传返回的 publicUrl */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^https?:\/\//i, { message: '头像必须是 http(s) 地址' })
  avatarUrl?: string;
}
