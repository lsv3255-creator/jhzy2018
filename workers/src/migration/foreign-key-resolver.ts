/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ID Mapping Engine · Resolver
 * ---------------------------------------------------------------------------
 * 二、Resolver：resolveForeignKeys(plan, rows, maps)
 *   自动完成：old_id -> new_id -> public_id 的外键重映射。
 *   - 引用值存在且可解析            -> RESOLVED
 *   - 可空且值缺失/不可解析        -> SKIPPED
 *   - 不可空且值缺失/不可解析      -> FAILED（FK 丢失，交由 Collision Checker 上报）
 *   全程依据 maps 索引反查，引擎不硬编码任何具体 old→new 关系。
 * ---------------------------------------------------------------------------
 */
import type {
  MappingPlan,
  SourceRow,
  LegacyIdMapRecord,
  ForeignKeyResolution,
} from './mapping-types';
import { MAP_KEY_SEP } from './mapping-types';
import { readField } from './mapping-builder';

/** 构建 (legacyTable, legacyId, newTable) -> record 索引（纯数据驱动） */
function buildIndex(maps: LegacyIdMapRecord[]): Map<string, LegacyIdMapRecord> {
  const idx = new Map<string, LegacyIdMapRecord>();
  for (const m of maps) {
    // 空 legacyId 的行是分配型，无法被旧 id 反查，不进索引
    if (m.legacyId !== '') {
      idx.set(`${m.legacyTable}${MAP_KEY_SEP}${m.legacyId}${MAP_KEY_SEP}${m.newTable}`, m);
    }
  }
  return idx;
}

function legacyTableOf(plan: MappingPlan, entity: string): string {
  const desc = plan.entities.find((e) => e.entity === entity);
  if (!desc) return entity;
  return plan.namespace ? `${plan.namespace}.${entity}` : entity;
}

export interface FkResult {
  resolutions: ForeignKeyResolution[];
  resolved: number;
  skipped: number;
  failed: number;
}

/**
 * 自动解析全部声明式外键，输出每条引用的解析结果与状态计数。
 */
export function resolveForeignKeys(
  plan: MappingPlan,
  rows: SourceRow[],
  maps: LegacyIdMapRecord[],
): FkResult {
  const index = buildIndex(maps);
  const groups = new Map<string, SourceRow[]>();
  for (const r of rows) {
    const arr = groups.get(r.entity);
    if (arr) arr.push(r);
    else groups.set(r.entity, [r]);
  }

  const resolutions: ForeignKeyResolution[] = [];
  let resolved = 0;
  let skipped = 0;
  let failed = 0;

  for (const fk of plan.foreignKeys) {
    const lt = legacyTableOf(plan, fk.toEntity);
    const toDesc = plan.entities.find((e) => e.entity === fk.toEntity);
    const newTable = toDesc ? toDesc.newTable : fk.toEntity;
    const rs = groups.get(fk.fromEntity) ?? [];
    for (const r of rs) {
      const fromLid = readField(r.values, 'id'); // 仅用于溯源记录
      const ref = readField(r.values, fk.field);
      if (ref === null) {
        if (fk.nullable) {
          skipped++;
          resolutions.push({
            fromEntity: fk.fromEntity, fromLegacyId: fromLid, field: fk.field, toEntity: fk.toEntity,
            oldRef: null, newId: null, publicId: null, status: 'SKIPPED', reason: 'nullable FK 值缺失',
          });
        } else {
          failed++;
          resolutions.push({
            fromEntity: fk.fromEntity, fromLegacyId: fromLid, field: fk.field, toEntity: fk.toEntity,
            oldRef: null, newId: null, publicId: null, status: 'FAILED', reason: '不可空 FK 值缺失',
          });
        }
        continue;
      }
      const rec = index.get(`${lt}${MAP_KEY_SEP}${ref}${MAP_KEY_SEP}${newTable}`);
      if (rec) {
        resolved++;
        resolutions.push({
          fromEntity: fk.fromEntity, fromLegacyId: fromLid, field: fk.field, toEntity: fk.toEntity,
          oldRef: ref, newId: rec.newId, publicId: rec.publicId, status: 'RESOLVED',
        });
      } else if (fk.nullable) {
        skipped++;
        resolutions.push({
          fromEntity: fk.fromEntity, fromLegacyId: fromLid, field: fk.field, toEntity: fk.toEntity,
          oldRef: ref, newId: null, publicId: null, status: 'SKIPPED', reason: 'nullable FK 引用未映射',
        });
      } else {
        failed++;
        resolutions.push({
          fromEntity: fk.fromEntity, fromLegacyId: fromLid, field: fk.field, toEntity: fk.toEntity,
          oldRef: ref, newId: null, publicId: null, status: 'FAILED', reason: '不可空 FK 引用未映射（FK 丢失）',
        });
      }
    }
  }

  return { resolutions, resolved, skipped, failed };
}
