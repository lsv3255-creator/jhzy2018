/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ID Mapping Engine · Builder
 * ---------------------------------------------------------------------------
 * 一、Builder：buildMappings(plan, rows)
 *   - 输入：V1 全量源数据（按 plan.entities 声明的实体批量处理）
 *   - 输出：legacy_id_maps 记录数组（一次批量建立 Users/Activities/Certificates/
 *           Attendance/Points/Teams 等）
 *   - 规则：
 *       * 源行含整数 legacy id  -> 1:1 沿用（newId = 旧 id，符合 01-spec「整数 PK 沿用」）
 *       * 源行缺失整数 legacy id -> 在 (该 newTable 已见最大 id + 1) 基础上分配新整数，
 *         保证不与 1:1 段冲突
 *       * 每个映射生成 ULID public_id（除非 generatePublicId=false）
 *   - 全程由数据驱动，引擎内部不硬编码任何 old→new 关系。
 * ---------------------------------------------------------------------------
 */
import { generateUlid } from '../utils/crypto';
import type {
  EntityDescriptor,
  MappingPlan,
  SourceRow,
  LegacyIdMapRecord,
} from './mapping-types';

const INT_RE = /^\d+$/;

/** 安全读取源行字段为字符串（null/空统一归一为 null） */
export function readField(values: Record<string, unknown>, field: string): string | null {
  const v = values[field];
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' ? null : s;
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

export interface BuildResult {
  maps: LegacyIdMapRecord[];
  byEntity: Record<string, number>;
}

function legacyTableOf(plan: MappingPlan, desc: EntityDescriptor): string {
  return plan.namespace ? `${plan.namespace}.${desc.entity}` : desc.entity;
}

/**
 * 依据声明式 plan，对 V1 全量源数据批量生成 legacy_id_maps。
 */
export function buildMappings(plan: MappingPlan, rows: SourceRow[]): BuildResult {
  // 1) 按实体分组
  const groups = new Map<string, SourceRow[]>();
  for (const r of rows) {
    const arr = groups.get(r.entity);
    if (arr) arr.push(r);
    else groups.set(r.entity, [r]);
  }

  // 2) 预扫描：确定每个 newTable 已出现的最大整数 legacy id（用于安全分配新 id）
  const maxByTable = new Map<string, number>();
  for (const desc of plan.entities) {
    const rs = groups.get(desc.entity) ?? [];
    for (const r of rs) {
      const lid = readField(r.values, desc.legacyIdField);
      if (lid && INT_RE.test(lid)) {
        const n = parseInt(lid, 10);
        maxByTable.set(desc.newTable, Math.max(maxByTable.get(desc.newTable) ?? 0, n));
      }
    }
  }

  // 3) 分配计数器：从 max+1 起（仅当存在整数 legacy id 时）
  const alloc = new Map<string, number>();
  for (const [t, m] of maxByTable) alloc.set(t, m + 1);

  // 4) 生成映射
  const maps: LegacyIdMapRecord[] = [];
  const byEntity: Record<string, number> = {};
  for (const desc of plan.entities) {
    const lt = legacyTableOf(plan, desc);
    const rs = groups.get(desc.entity) ?? [];
    let count = 0;
    for (const r of rs) {
      const lidRaw = readField(r.values, desc.legacyIdField);
      let newId: number;
      if (lidRaw && INT_RE.test(lidRaw)) {
        newId = parseInt(lidRaw, 10); // 1:1 沿用
      } else {
        const next = alloc.get(desc.newTable) ?? 1;
        newId = next;
        alloc.set(desc.newTable, next + 1);
      }
      const code = desc.legacyCodeField ? readField(r.values, desc.legacyCodeField) : null;
      const publicId = desc.generatePublicId === false ? null : generateUlid();
      maps.push({
        legacyTable: lt,
        legacyId: lidRaw ?? '',
        legacyCode: code,
        newTable: desc.newTable,
        newId,
        publicId,
      });
      count++;
    }
    byEntity[desc.entity] = count;
  }

  return { maps, byEntity };
}
