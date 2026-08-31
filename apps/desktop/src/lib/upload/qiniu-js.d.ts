/**
 * qiniu-js@2.x 的最小类型声明（SDK 未随包发布 .d.ts）。
 * API 形状与官方历史文档 2.x 对齐，仅声明本项目用到的部分。
 * https://developer-doc.qiniu.com/products/kodo/javascript/1-javascript-sdk-historical-document-2-x
 */
declare module 'qiniu-js' {
  export interface QiniuUploadConfig {
    /** 是否使用 CDN 加速上传域名 */
    useCdnDomain?: boolean;
    /** 是否禁用日志上报 */
    disableStatisticsReport?: boolean;
    /** 上传区域：qiniu.region.z0 / z1 / z2 / na0 / as0；缺省时自动分析 */
    region?: string;
    /** 整体上传重试次数（仅 599 内部错误生效），默认 3 */
    retryCount?: number;
    /** 分片上传并发数，默认 3 */
    concurrentRequestLimit?: number;
    /** 断点续传时是否用 MD5 比对已上传分片 */
    checkByMD5?: boolean;
  }

  export interface QiniuPutExtra {
    /** 文件原始文件名 */
    fname?: string;
    /** 自定义变量（需在 putPolicy 中声明方可收到） */
    params?: Record<string, string>;
    /** 限定上传文件类型；null 时自动判断 */
    mimeType?: string[] | null;
  }

  export interface QiniuProgress {
    total: {
      /** 已上传字节数 */
      loaded: number;
      /** 本次上传总量控制信息（与文件大小不一定一致） */
      total: number;
      /** 0 ~ 100 */
      percent: number;
    };
  }

  export interface QiniuError {
    /** xhr 请求错误时为 true */
    isRequestError?: boolean;
    /** 七牛错误码（如 614 文件已存在、579 回调失败） */
    code?: number;
    message: string;
    reqId?: string;
  }

  /** 内容取决于凭证 returnBody（本项目：key/hash/fsize/mime/fname） */
  export interface QiniuCompleteRes {
    key: string;
    hash: string;
    fsize?: number;
    mime?: string;
    fname?: string;
  }

  export interface QiniuSubscription {
    /** 取消订阅并终止上传 */
    unsubscribe(): void;
  }

  export interface QiniuObservable {
    subscribe(observer: {
      next?: (res: QiniuProgress) => void;
      error?: (err: QiniuError) => void;
      complete?: (res: QiniuCompleteRes) => void;
    }): QiniuSubscription;
  }

  export const region: Record<'z0' | 'z1' | 'z2' | 'na0' | 'as0', string>;

  export function upload(
    file: Blob,
    key: string,
    token: string,
    putExtra?: QiniuPutExtra,
    config?: QiniuUploadConfig,
  ): QiniuObservable;
}
