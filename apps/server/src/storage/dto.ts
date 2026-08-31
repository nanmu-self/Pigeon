import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { UploadDir } from '@pigeon/shared-types';

/**
 * 上传目录白名单。
 *
 * 注意：@pigeon/shared-types 是 type-only 包（运行时无 JS 产物，import 它的值
 * 会 ERR_MODULE_NOT_FOUND，见 AGENTS.md 约定 3），因此这里本地定义白名单；
 * 下面的编译期断言保证它与 UploadDir 联合类型严格一致——UploadDir 新增成员
 * 而这里未同步时，tsc 直接报错。
 */
const UPLOAD_DIRS = ['avatar', 'chat', 'file'] as const satisfies readonly UploadDir[];

/** UploadDir 新增成员而 UPLOAD_DIRS 未同步时，下一行的赋值会类型报错（never 不可赋给 true） */
type AllDirsCovered = [Exclude<UploadDir, (typeof UPLOAD_DIRS)[number]>] extends [never]
  ? true
  : never;
const _ASSERT_ALL_DIRS_COVERED: AllDirsCovered = true;
void _ASSERT_ALL_DIRS_COVERED;

export class UploadTokenDto {
  /** 上传目录（决定路径前缀与大小/类型限制），缺省 file */
  @IsOptional()
  @IsIn([...UPLOAD_DIRS])
  dir?: UploadDir;

  /** 原始文件名，仅用于推断扩展名 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}

/** GET /storage/session-token 查询参数（会话凭证仅限 chat/file，头像必须走 per-file 票） */
export class SessionDirQuery {
  @IsOptional()
  @IsIn(['chat', 'file'])
  dir?: 'chat' | 'file';
}
