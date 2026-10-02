/**
 * PII 加密 / 脱敏工具（P0-A）。
 *
 * 安全纪律：
 * - 身份证明文永不写库；仅存 HMAC 指纹（id_card_hash / identity_fingerprint）与脱敏展示（id_card_mask）。
 * - 真实姓名以 AES-256-GCM 加密（real_name_enc）；密钥由 IDENTITY_HMAC_KEY 派生，绝不硬编码。
 * - 本模块仅依赖 Web Crypto（Workers 原生），不在前端 / 日志暴露明文。
 * - AES 密钥由 HMAC 密钥派生（domain-separated），不引入第二把需要保管的密钥。
 */

import { hmacSha256Hex } from './crypto';

/** AES-256-GCM 密钥派生：HMAC-SHA256(hmacKey, domain) → 32 字节 raw。 */
async function deriveAesKeyBytes(hmacKey: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const ck = await crypto.subtle.importKey(
    'raw',
    enc.encode(hmacKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', ck, enc.encode(`${hmacKey}:jhzy-pii-aes-v1`));
  return new Uint8Array(sig);
}

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class PiiCrypto {
  private aesKey: Promise<CryptoKey>;

  constructor(private readonly hmacKey: string) {
    this.aesKey = (async () => {
      const raw = await deriveAesKeyBytes(hmacKey);
      return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    })();
  }

  /** 身份证 HMAC 指纹（与 user_identities.identity_hash 同源密钥）。 */
  async hashIdCard(idCard: string): Promise<string> {
    return hmacSha256Hex(this.hmacKey, idCard);
  }

  /** AES-256-GCM 加密明文（真实姓名），返回 iv:ciphertext（base64url）。 */
  async encryptRealName(plain: string): Promise<string> {
    const key = await this.aesKey;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plain),
    );
    return `${b64url(iv)}:${b64url(new Uint8Array(ct))}`;
  }

  /** 解密 real_name_enc（仅服务端 / 审计需要时使用；本阶段 API 不返回明文）。 */
  async decryptRealName(cipher: string): Promise<string> {
    const key = await this.aesKey;
    const [ivB64, ctB64] = cipher.split(':');
    const iv = fromB64url(ivB64);
    const ct = fromB64url(ctB64);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  /** 通用 PII 加密（与真实姓名/手机号同密钥派生，同一 envelope `iv:ct` base64url）。
   *  用于 volunteer_profiles 中无法归入姓名/手机字段的复合 PII（如 emergency_contact JSON）。
   *  解密仅需同一 IDENTITY_HMAC_KEY，与运行时完全一致。 */
  async encryptGeneric(plain: string): Promise<string> {
    const key = await this.aesKey;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
    return `${b64url(iv)}:${b64url(new Uint8Array(ct))}`;
  }

  /** 通用 PII 解密（仅可信 backend 路径；结果明文不返回客户端/不进日志）。 */
  async decryptGeneric(cipher: string): Promise<string> {
    const key = await this.aesKey;
    const [ivB64, ctB64] = cipher.split(':');
    const iv = fromB64url(ivB64);
    const ct = fromB64url(ctB64);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  /** 身份证脱敏：保留末 4 位，其余掩码。 */
  maskIdCard(idCard: string): string {
    if (idCard.length <= 4) return idCard;
    return '*'.repeat(idCard.length - 4) + idCard.slice(-4);
  }

  /** 姓名脱敏：保留首字，其余掩码。 */
  maskName(name: string): string {
    if (!name) return '';
    return name[0] + '*'.repeat(Math.max(1, name.length - 1));
  }

  /** 手机号 AES-256-GCM 加密（与真实姓名同密钥派生），返回 iv:ciphertext（base64url）。 */
  async encryptPhone(plain: string): Promise<string> {
    const key = await this.aesKey;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plain),
    );
    return `${b64url(iv)}:${b64url(new Uint8Array(ct))}`;
  }

  /** 手机号解密（仅可信 backend 路径；结果明文不返回客户端 / 不进日志）。 */
  async decryptPhone(cipher: string): Promise<string> {
    const key = await this.aesKey;
    const [ivB64, ctB64] = cipher.split(':');
    const iv = fromB64url(ivB64);
    const ct = fromB64url(ctB64);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  /** 手机号 HMAC 指纹（与身份证同密钥体系，HMAC-SHA256）。用于去重 / 幂等。 */
  async hashPhone(phone: string): Promise<string> {
    return hmacSha256Hex(this.hmacKey, phone);
  }

  /** 手机号脱敏：前 3 + **** + 后 4（11 位中国大陆手机号）。短号原样返回。 */
  maskPhone(phone: string): string {
    if (phone.length < 7) return phone;
    return phone.slice(0, 3) + '****' + phone.slice(-4);
  }
}

/** 身份证基础格式校验：17 位数字 + 末位（数字或 X）。 */
export function isValidIdCard(v: unknown): v is string {
  return typeof v === 'string' && /^\d{17}[\dX]$/.test(v);
}
