import { Body, Controller, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import type { UploadSessionTicket, UploadTicket } from '@pigeon/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { SessionDirQuery, UploadTokenDto } from './dto.js';
import { QiniuStorageService } from './qiniu.service.js';

/**
 * 对象存储接口 — 前端直传七牛云的取票入口。
 *
 * 前端流程：携带 JWT 调 POST /storage/upload-token 换取 UploadTicket，
 * 再用 qiniu-js（token + key）直传七牛上传域名，业务服务器不经手文件流。
 */
@Controller('storage')
@UseGuards(JwtAuthGuard)
export class StorageController {
  constructor(
    // swc 编译无装饰器元数据，注入一律显式 @Inject（与全仓库约定一致）
    @Inject(QiniuStorageService) private readonly storage: QiniuStorageService,
  ) {}

  /** 颁发一次七牛直传凭证（scope 定向到服务端生成的 key，有效期见响应） */
  @Post('upload-token')
  @HttpCode(200)
  issueToken(@Body() dto: UploadTokenDto): UploadTicket {
    return this.storage.issueTicket(dto);
  }

  /**
   * 获取目录级会话凭证（chat/file）。
   * scope=bucket + insertOnly，有效期内可复用于该目录多个文件；
   * 客户端缓存并在剩余 < 10 分钟时懒刷新，key 由客户端按约定规则生成。
   */
  @Get('session-token')
  sessionToken(@Query() query: SessionDirQuery): UploadSessionTicket {
    return this.storage.issueSessionTicket(query.dir ?? 'file');
  }
}
