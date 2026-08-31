/**
 * 认证相关 API(/auth/*)。
 *
 * captchaId 一次性:登录/注册无论成败,前端都应重新拉取验证码。
 * token 持久化语义(记住我)见 http.ts 的 tokenStore。
 */
import type {
  AuthResult,
  CaptchaChallenge,
  LoginInput,
  RegisterInput,
} from '@pigeon/shared-types';
import { http } from './http';

export const authApi = {
  /** 拉取一张新图形验证码(PNG dataURL) */
  captcha: () => http.Get<CaptchaChallenge>('/auth/captcha'),
  register: (data: RegisterInput) => http.Post<AuthResult>('/auth/register', data),
  login: (data: LoginInput) => http.Post<AuthResult>('/auth/login', data),
};
