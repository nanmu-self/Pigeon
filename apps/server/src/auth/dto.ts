import { IsEmail, IsNotEmpty, IsString, Length, MaxLength, MinLength } from 'class-validator';
import type { LoginInput, RegisterInput } from '@pigeon/shared-types';

/**
 * 注册入参。校验失败由全局 ValidationPipe 统一返回 400。
 * captchaId/captchaCode 来自 GET /auth/captcha,一次性使用。
 */
export class RegisterDto implements RegisterInput {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  /** 明文密码,仅用于传输,入库前经 bcrypt 哈希(8~72 位,72 为 bcrypt 输入上限) */
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(72, { message: '密码最多 72 位' })
  password!: string;

  @IsString()
  @Length(2, 32, { message: '昵称长度需在 2~32 个字符' })
  nickname!: string;

  @IsString()
  @IsNotEmpty({ message: '请先获取验证码' })
  captchaId!: string;

  @IsString()
  @IsNotEmpty({ message: '请输入验证码' })
  @MaxLength(16)
  captchaCode!: string;
}

export class LoginDto implements LoginInput {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email!: string;

  @IsString()
  @MaxLength(72)
  password!: string;

  @IsString()
  @IsNotEmpty({ message: '请先获取验证码' })
  captchaId!: string;

  @IsString()
  @IsNotEmpty({ message: '请输入验证码' })
  @MaxLength(16)
  captchaCode!: string;
}
