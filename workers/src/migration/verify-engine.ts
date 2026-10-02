/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ID Mapping Engine · Verify Engine
 * ---------------------------------------------------------------------------
 * 四、Verify Engine：verifyMappings(plan, rows, maps, resolutions)
 *   自动验证：
 *     - 每个实体的【源数量 -> 目标数量】是否一致（maps 是否完整覆盖源行）
 *     - 每个外键是否【全部可解析】（无 FAILED）
 * ---------------------------------------------------------------------------
 */
import type {
  MappingPlan,
  SourceRow,
  LegacyIdMapRecord,
  ForeignKeyResolution,
  VerifyResult,
  EntityVerifyCheck,
  FkVerifyCheck,
} from './mapping-types';

export function verifyMappings(
  plan: MappingPlan,
  rows: SourceRow[],
  maps: LegacyIdMapRecord[],
  resolutions: ForeignKeyResolution[],
): VerifyResult {
  const groups = new Map<string, SourceRow[]>();
  for (const r of rows) {
    const arr = groups.get(r.entity);
    if (arr) arr.push(r);
    else groups.set(r.entity, [r]);
  }

  const entityChecks: EntityVerifyCheck[] = [];
  for (const desc of plan.entities) {
    const lt = plan.namespace ? `${plan.namespace}.${desc.entity}` : desc.entity;
    const sourceCount = (groups.get(desc.entity) ?? []).length;
    const targetCount = maps.filter((m) => m.legacyTable === lt && m.newTable === desc.newTable).length;
    entityChecks.push({ entity: desc.entity, sourceCount, targetCount, pass: sourceCount === targetCount });
  }

  const total = resolutions.length;
  const resolved = resolutions.filter((r) => r.status === 'RESOLVED').length;
  const skipped = resolutions.filter((r) => r.status === 'SKIPPED').length;
  const failed = resolutions.filter((r) => r.status === 'FAILED').length;
  const fkCheck: FkVerifyCheck = { total, resolved, skipped, failed, pass: failed === 0 };

  const pass = entityChecks.every((c) => c.pass) && fkCheck.pass;
  return { entityChecks, fkCheck, pass };
}
