import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller.js';
import { QiniuStorageService } from './qiniu.service.js';

@Module({
  controllers: [StorageController],
  providers: [QiniuStorageService],
})
export class StorageModule {}
