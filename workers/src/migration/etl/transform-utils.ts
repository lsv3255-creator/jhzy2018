/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ETL Engine · 转换工具（F8-4）
 * ---------------------------------------------------------------------------
 * 纯函数工具：时间转换、枚举转换、数值工具、随机码。
 * 所有映射以「值转换表」形式声明（非 ID 硬编码），符合 spec §1.5 / §2.x 规则。
 * ---------------------------------------------------------------------------
 */

/** 安全转整数（null/空/NaN → null） */
export function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** 安全转浮点（null/空/NaN → 0） */
export function toNumber(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
}

/**
 * V1 DATETIME/DATE → V2 Unix  epoch（秒）。
 * V1 时间为东八区写入；naive DATETIME 视为 UTC+8 解析，避免本地时区漂移。
 * null/空/非法 → null。
 */
export function v1DateTimeToEpoch(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  const s = String(v).trim();
  let iso: string;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    iso = s.replace(' ', 'T') + '+08:00';
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    iso = s + 'T00:00:00+08:00';
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
    iso = s; // 已是 ISO（含或不含时区）
  } else {
    return null; // 无法识别的日期格式
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** 小时 → 分钟（×60，四舍五入） */
export function hoursToMinutes(v: unknown): number {
  const n = toNumber(v, 0);
  return Math.round(n * 60);
}

// ---- 枚举转换（spec §2.x） ----

/** 性别：V1 '1'/'2'/'男'/'女'/NULL → V2 0(未知)/1(男)/2(女) */
export function mapGender(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).trim();
  if (s === '1' || s === '男') return 1;
  if (s === '2' || s === '女') return 2;
  return 0;
}

/** 志愿者状态：V1 1(正常)/2(停用) → V2 1/2 */
export function mapVolunteerStatus(v: unknown): number {
  return toInt(v) === 2 ? 2 : 1;
}

/** 活动状态派生（spec §2.3.7）：0 草稿；按 now 与起止时间推导 1/2/3 */
export function deriveActivityStatus(row: Record<string, unknown>, now: number): number {
  const status = toInt(row.status);
  const published = toInt(row.is_published) === 1;
  if (status === 0) return 0; // 草稿
  const start = v1DateTimeToEpoch(row.start_time);
  const end = v1DateTimeToEpoch(row.end_time);
  if (start === null || end === null) return published ? 1 : 0;
  if (now < start) return 1; // 报名中
  if (now > end) return 3; // 已完成
  return 2; // 进行中
}

/** 报名审核状态：1→1(通过)/2→2(驳回)/其它→0(待审) */
export function mapReviewStatus(v: unknown): number {
  const n = toInt(v);
  if (n === 2) return 2;
  if (n === 1) return 1;
  return 0;
}

/** 报名状态：1→1(已报名)/2→2(已取消) */
export function mapSignupStatus(v: unknown): number {
  return toInt(v) === 2 ? 2 : 1;
}

/** 考勤状态派生（spec §2.5.7）：签退→2 / 签到→1 / 无→0 */
export function deriveAttendanceStatus(row: Record<string, unknown>): number {
  const checkout = row.checkout_time != null && String(row.checkout_time) !== '';
  const checkin = row.checkin_time != null && String(row.checkin_time) !== '';
  if (checkout) return 2;
  if (checkin) return 1;
  return 0;
}

/** 团队角色：'管理员'→'admin'，其它→'member' */
export function mapTeamRole(v: unknown): string {
  const s = v == null ? '' : String(v).trim();
  if (s === '管理员') return 'admin';
  return 'member';
}

/** 证书状态：有效/active/1 → 1；revoked/2 → 2 */
export function mapCertStatus(v: unknown): number {
  const s = v == null ? '' : String(v).trim();
  if (s === 'revoked' || s === '2') return 2;
  return 1;
}

/** 生成证书验真码（随机 hex） */
export function genVerifyCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** 安全取字符串（null/空 → null） */
export function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
