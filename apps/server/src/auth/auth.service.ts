import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import type { PublicUser } from '@pigeon/shared-types';
import { PrismaService } from '../prisma.service.js';
import { CaptchaService } from './captcha.service.js';
import type { LoginDto, RegisterDto } from './dto.js';

/** bcrypt 计算成本因子:10 约几十毫秒/次,登录接口可接受 */
const BCRYPT_ROUNDS = 10;

/** 登录成功后签发的 JWT 载荷(WS 网关验签使用同一结构) */
export interface JwtPayload {
  /** JWT 标准声明:用户 id 的字符串形式 */
  sub: string;
  userId: number;
  email: string;
  nickname: string;
}

/** 不含密码哈希的用户公开信息(结构定义见 @pigeon/shared-types) */
export type { PublicUser } from '@pigeon/shared-types';

export interface AuthResult {
  user: PublicUser;
  token: string;
}

/** 是否为 PostgreSQL 唯一约束冲突(sqlstate 23505) */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { sqlState?: string }).sqlState === '23505'
  );
}

interface UserRow {
  id: number;
  email: string;
  password: string;
  nickname: string;
  createdAt: string;
}

@Injectable()
export class AuthService {
  constructor(
    // 本仓库用 swc/esbuild 编译,不产出装饰器元数据,注入一律显式 @Inject
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(CaptchaService) private readonly captcha: CaptchaService,
  ) {}

  /**
   * 注册:邮箱小写归一化,密码 bcrypt 哈希后入库。
   * 成功即返回 token(注册即登录),前端无需再调一次 login。
   */
  async register(dto: RegisterDto): Promise<AuthResult> {
    this.assertCaptcha(dto.captchaId, dto.captchaCode);

    const email = dto.email.trim().toLowerCase();
    const nickname = dto.nickname.trim();

    const existing = await this.prisma.orm.public.User.first({ email });
    if (existing) throw new ConflictException('该邮箱已被注册');

    const passwordHash = await hash(dto.password, BCRYPT_ROUNDS);
    try {
      const row = await this.prisma.orm.public.User.create({
        email,
        password: passwordHash,
        nickname,
      });
      return { user: this.toPublic(row), token: this.signToken(row) };
    } catch (error) {
      // 查重与写入之间的并发兜底:唯一索引冲突 → 409
      if (isUniqueViolation(error)) throw new ConflictException('该邮箱已被注册');
      throw error;
    }
  }

  /** 登录:校验密码哈希并签发 JWT。统一错误文案,避免枚举出已注册邮箱 */
  async login(dto: LoginDto): Promise<AuthResult> {
    // 验证码放在账号存在性检查之前:错误验证码无法用来探测已注册邮箱
    this.assertCaptcha(dto.captchaId, dto.captchaCode);

    const email = dto.email.trim().toLowerCase();
    const row = await this.prisma.orm.public.User.first({ email });
    if (!row) throw new UnauthorizedException('邮箱或密码错误');

    const passwordOk = await compare(dto.password, row.password);
    if (!passwordOk) throw new UnauthorizedException('邮箱或密码错误');

    return { user: this.toPublic(row), token: this.signToken(row) };
  }

  /** 验证码不通过 → 400(一次性消费,重试需换新验证码) */
  private assertCaptcha(captchaId: string, captchaCode: string): void {
    if (!this.captcha.verify(captchaId, captchaCode)) {
      throw new BadRequestException('验证码错误或已过期');
    }
  }

  private toPublic(row: UserRow): PublicUser {
    return {
      id: row.id,
      email: row.email,
      nickname: row.nickname,
      createdAt: row.createdAt,
    };
  }

  private signToken(row: Pick<UserRow, 'id' | 'email' | 'nickname'>): string {
    const payload: JwtPayload = {
      sub: String(row.id),
      userId: row.id,
      email: row.email,
      nickname: row.nickname,
    };
    return this.jwt.sign(payload);
  }
}
