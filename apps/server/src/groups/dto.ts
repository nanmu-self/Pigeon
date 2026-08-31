import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateGroupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @IsArray()
  @ArrayMaxSize(199)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  memberIds!: number[];
}

export class InviteMembersDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  userIds!: number[];
}

export class TransferOwnerDto {
  @IsInt()
  @IsPositive()
  toUserId!: number;
}

export class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;
}

export class UpdateAnnouncementDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content!: string;
}

export class UpdateMuteDto {
  @IsBoolean()
  muteAll!: boolean;
}
