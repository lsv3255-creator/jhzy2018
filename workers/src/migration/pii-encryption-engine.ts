/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：通用 PII 加密引擎（F8-3，detached）
 * ---------------------------------------------------------------------------
 * 【DOMAIN 收敛声明 · STEP 3.11】
 *   自 STEP 3.11 起，volunteer_profiles 的 real_name_enc / phone_enc / id_card_hash /
 *   emergency_contact_enc 统一由运行时 PiiCrypto（src/utils/pii.ts，密钥 = IDENTITY_HMAC_KEY）
 *   生成，与本引擎无关。本引擎的 AES 密钥派生使用独立 secret（历史上对应 DELIVERY_IDENTITY_ENC_KEY
 *   域的 detached PII），不再参与 volunteer profile PII 加密，以避免 key-contract drift。
 *
 * 合法用途（保留，不删除）：
 *   - 作为通用 AES-256-GCM + HMAC-SHA256 工具被显式调用（如非 volunteer 域的 detached PII）。
 *   - selfTestPii() 仍是 F8-3 加密原语正确性回归。
 *
 * 设计边界：
 *   - 仅作为迁移/工具库被调用，不进入业务路由请求热路径。
 *   - 不修改生产库、不部署、不新增业务功能。
 *   - 全部基于 Workers 原生 Web Crypto（AES-GCM / HMAC / SHA-256），环境无关。
 * ---------------------------------------------------------------------------
 */
import { hmacSha256Hex } from '../utils/crypto';

const TE = new TextEncoder();
const TD = new TextDecoder();

export type PiiFieldType =
  | 'real_name'
  | 'id_card'
  | 'phone'
  | 'email'
  | 'bank_account'
  | 'address'
  | 'generic';

export interface EncryptedPayload {
  iv: string; // base64 (12 bytes)
  ct: string; // base64 (ciphertext + GCM tag)
}

function b64(buf: Uint8Array): string {
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64d(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 由 Secret 派生 32 字节 AES-256 密钥（SHA-256(secret)） */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', TE.encode(secret));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** AES-256-GCM 加密（随机 12 字节 IV，每次不同） */
export async function aesGcmEncrypt(plain: string, key: CryptoKey): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, TE.encode(plain));
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

/** AES-256-GCM 解密（含 GCM tag 校验，篡改即抛错） */
export async function aesGcmDecrypt(p: EncryptedPayload, key: CryptoKey): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(p.iv) }, key, b64d(p.ct));
  return TD.decode(pt);
}

/** 复合存储 token（单字段落库）：`ivB64.ctB64` */
export async function encryptToken(plain: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const p = await aesGcmEncrypt(plain, key);
  return `${p.iv}.${p.ct}`;
}

/** 解析并解密复合 token */
export async function decryptToken(token: string, secret: string): Promise<string> {
  const [iv, ct] = token.split('.');
  if (!iv || !ct) throw new Error('decryptToken: 非法 token');
  const key = await deriveKey(secret);
  return aesGcmDecrypt({ iv, ct }, key);
}

/** HMAC-SHA256 摘要（用于 id_card 等需匹配字段的 hash 列） */
export function hmacValue(plain: string, secret: string): Promise<string> {
  return hmacSha256Hex(secret, plain);
}

/** 脱敏掩码（对外展示，不泄露明文） */
export function maskValue(plain: string | null, type: PiiFieldType): string | null {
  if (plain === null || plain === '') return plain;
  switch (type) {
    case 'real_name':
      return plain.length <= 1 ? plain : `${plain[0]}${'*'.repeat(plain.length - 1)}`;
    case 'phone':
      return plain.length >= 7 ? `${plain.slice(0, 3)}****${plain.slice(-4)}` : '****';
    case 'id_card':
      return plain.length >= 8 ? `${plain.slice(0, 4)}${'*'.repeat(plain.length - 8)}${plain.slice(-4)}` : '********';
    case 'email': {
      const [a, dom] = plain.split('@');
      if (!dom) return '***';
      const head = a.length <= 1 ? a[0] : `${a[0]}***`;
      return `${head}@${dom}`;
    }
    case 'bank_account':
      return plain.length >= 4 ? `****${plain.slice(-4)}` : '****';
    case 'address':
      return plain.length <= 3 ? plain : `${plain.slice(0, 3)}***`;
    default:
      return plain.length <= 1 ? plain : `${plain[0]}***`;
  }
}

export interface PiiFieldResult {
  /** 加密 token（落 *_enc 列） */
  enc: string;
  /** HMAC 摘要（落 *_hash 列；generic 类型为空串） */
  hash: string;
  /** 脱敏掩码（落 *_mask 列） */
  mask: string;
}

/**
 * 便捷入口：对单个 PII 字段一次性产出 { enc, hash, mask }。
 * - enc  始终生成（AES-256-GCM）
 * - hash 仅对需匹配的字段（id_card）生成，其余为空串
 * - mask 始终生成
 */
export async function encryptPiiField(
  plain: string | null,
  type: PiiFieldType,
  secret: string,
): Promise<PiiFieldResult | null> {
  if (plain === null || plain === '') return null;
  const enc = await encryptToken(plain, secret);
  const hash = type === 'id_card' ? await hmacValue(plain, secret) : '';
  const mask = maskValue(plain, type) ?? '';
  return { enc, hash, mask };
}

/**
 * 自测：加密/解密往返、HMAC 稳定、掩码格式、复合 token。
 * 不触碰任何外部存储。
 */
export async function selfTestPii(): Promise<{ pass: boolean; checks: string[] }> {
  const checks: string[] = [];
  let pass = true;
  const fail = (m: string): void => {
    pass = false;
    checks.push('FAIL: ' + m);
  };

  const secret = 'test-secret-for-self-test-only';
  const key = await deriveKey(secret);

  // 1) AES-GCM 往返
  const p = await aesGcmEncrypt('张三 110101199003071234', key);
  const back = await aesGcmDecrypt(p, key);
  if (back !== '张三 110101199003071234') fail('AES-GCM 解密不一致');
  else checks.push('OK: AES-256-GCM 加解密往返');

  // 2) 复合 token 往返
  const tok = await encryptToken('13900001234', secret);
  const dec = await decryptToken(tok, secret);
  if (dec !== '13900001234') fail('token 解密不一致');
  else checks.push('OK: encrypt/decryptToken 往返');

  // 3) GCM 篡改检测（改 iv 末位）
  try {
    const tampered = { ...p, iv: p.iv.slice(0, -1) + (p.iv.slice(-1) === 'A' ? 'B' : 'A') };
    await aesGcmDecrypt(tampered, key);
    fail('篡改的密文应解密失败');
  } catch {
    checks.push('OK: GCM tag 篡改检测');
  }

  // 4) HMAC 稳定且确定性
  const h1 = await hmacValue('110101199003071234', secret);
  const h2 = await hmacValue('110101199003071234', secret);
  if (h1 !== h2 || h1.length !== 64) fail(`HMAC 不稳定/长度异常 (${h1.length})`);
  else checks.push('OK: HMAC-SHA256 稳定(64hex)');
  if (await hmacValue('different', secret) === h1) fail('HMAC 应随输入变化');
  else checks.push('OK: HMAC 输入敏感性');

  // 5) 掩码格式
  if (maskValue('张三', 'real_name') !== '张*') fail('姓名掩码错误');
  else checks.push('OK: 姓名掩码');
  if (maskValue('13900001234', 'phone') !== '139****1234') fail('手机掩码错误');
  else checks.push('OK: 手机掩码');
  if (maskValue('110101199003071234', 'id_card') !== '1101**********1234') fail('身份证掩码错误');
  else checks.push('OK: 身份证掩码');
  if (maskValue('zhang@jhzy.cn', 'email') !== 'z***@jhzy.cn') fail('邮箱掩码错误');
  else checks.push('OK: 邮箱掩码');
  if (maskValue(null, 'phone') !== null) fail('null 应原样返回');

  // 6) encryptPiiField 字段结果
  const r = await encryptPiiField('110101199003071234', 'id_card', secret);
  if (!r || r.enc.split('.').length !== 2) fail('encryptPiiField.enc 格式错误');
  else checks.push('OK: encryptPiiField enc 复合 token');
  if (!r || r.hash.length !== 64) fail('id_card hash 应生成');
  else checks.push('OK: id_card HMAC hash 生成');
  if (!r || r.mask !== '1101**********1234') fail('encryptPiiField.mask 错误');
  else checks.push('OK: encryptPiiField mask');
  const rg = await encryptPiiField('北京市海淀区', 'address', secret);
  if (!rg || rg.hash !== '') fail('address 不应生成 hash');
  else checks.push('OK: 非 id_card 字段 hash 为空');
  if (await encryptPiiField(null, 'phone', secret) !== null) fail('null 明文应返回 null');

  return { pass, checks };
}
