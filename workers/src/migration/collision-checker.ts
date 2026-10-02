/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ID Mapping Engine · Collision Checker
 * ---------------------------------------------------------------------------
 * 三、Collision Checker：checkCollisions(maps, resolutions)
 *   自动检查四类冲突并输出 MigrationConflictReport：
 *     - old_id 重复      ：同 (legacyTable, legacyId, newTable) 出现多个 newId
 *     - legacy_code 冲突：同一非空 legacyCode 映射到不同 newId
 *     - ULID 冲突        ：publicId 重复
 *     - FK 丢失          ：resolveForeignKeys 中 status==='FAILED'
 *   hasBlocking = old_id 重复 | ULID 冲突 | FK 丢失（任一项存在即阻断迁移）
 * ---------------------------------------------------------------------------
 */
import type {
  LegacyIdMapRecord,
  ForeignKeyResolution,
  MigrationConflictReport,
} from './mapping-types';
import { MAP_KEY_SEP } from './mapping-types';

export function checkCollisions(
  maps: LegacyIdMapRecord[],
  resolutions: ForeignKeyResolution[],
): MigrationConflictReport {
  // 1) old_id 重复：同一 (legacyTable, legacyId, newTable) 在源数据中出现多次
  //    —— 代表两条不同的 V1 行映射到同一旧 id，存在数据重复/丢失风险（阻断性）。
  const byKey = new Map<string, { legacyTable: string; legacyId: string; newIds: number[]; count: number }>();
  for (const m of maps) {
    const key = `${m.legacyTable}${MAP_KEY_SEP}${m.legacyId}${MAP_KEY_SEP}${m.newTable}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.count++;
      if (!cur.newIds.includes(m.newId)) cur.newIds.push(m.newId);
    } else {
      byKey.set(key, { legacyTable: m.legacyTable, legacyId: m.legacyId, newIds: [m.newId], count: 1 });
    }
  }
  const oldIdDuplicates = [...byKey.values()].filter((x) => x.count > 1);

  // 2) legacy_code 冲突
  const byCode = new Map<string, Array<{ newId: number; entity: string }>>();
  for (const m of maps) {
    if (m.legacyCode === null) continue;
    const arr = byCode.get(m.legacyCode);
    if (arr) {
      if (!arr.some((x) => x.newId === m.newId)) arr.push({ newId: m.newId, entity: m.legacyTable });
    } else {
      byCode.set(m.legacyCode, [{ newId: m.newId, entity: m.legacyTable }]);
    }
  }
  const legacyCodeConflicts = [...byCode.entries()]
    .filter(([, xs]) => xs.length > 1)
    .map(([legacyCode, xs]) => ({
      legacyCode,
      newIds: xs.map((x) => x.newId),
      entities: xs.map((x) => x.entity),
    }));

  // 3) ULID 冲突
  const byUlid = new Map<string, number>();
  for (const m of maps) {
    if (m.publicId === null) continue;
    byUlid.set(m.publicId, (byUlid.get(m.publicId) ?? 0) + 1);
  }
  const ulidConflicts = [...byUlid.entries()]
    .filter(([, c]) => c > 1)
    .map(([publicId, occurrences]) => ({ publicId, occurrences }));

  // 4) FK 丢失
  const fkLoss = resolutions.filter((r) => r.status === 'FAILED');

  const hasBlocking = oldIdDuplicates.length > 0 || ulidConflicts.length > 0 || fkLoss.length > 0;

  return { oldIdDuplicates, legacyCodeConflicts, ulidConflicts, fkLoss, hasBlocking };
}
