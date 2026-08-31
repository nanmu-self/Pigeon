import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { CaptchaChallenge } from '@pigeon/shared-types';
import { CaptchaService } from './captcha.service.js';
import { AuthService } from './auth.service.js';
import { LoginDto, RegisterDto } from './dto.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CaptchaService) private readonly captcha: CaptchaService,
  ) {}

  /** 拉取一张新图形验证码(PNG dataURL),captchaId 一次性使用,5 分钟有效 */
  @Get('captcha')
  issue(): CaptchaChallenge {
    return this.captcha.issue();
  }

  /** 注册(成功即登录,直接返回用户信息与 token) */
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  /** 登录:校验验证码与密码哈希,签发 JWT */
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }
}
