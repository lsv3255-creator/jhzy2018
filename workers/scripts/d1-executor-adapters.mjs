#!/usr/bin/env node
// =============================================================================
// CERT-R5A —— D1 执行适配器（把「真实 D1 / 本地 SQLite」桥接为 legacy-pool-importer
//            所需的 D1DatabaseLike，使 importLegacyPools 原样可调用）
//
// 两个实现：
//   1) createLocalSqliteD1()   —— node:sqlite，用于本地全量模拟与测试（零网络）
//   2) createRemoteD1Adapter() —— Cloudflare D1 REST API，用于 R5 生产写入
//
// 远程适配器关键设计（吞吐）：
//   importLegacyPools 逐行做「冲突 SELECT」+「UPSERT batch」。若逐行走 HTTP，
//   450,000 行将产生 ~90 万次请求，维护窗口内不可行。因此远程适配器：
//     · 启动时一次性载入既有 id_pools 的 (code → pool_type/status/provenance) 到内存 Map；
//       —— 既有行仅 500（或续跑时 450,500），内存可控，且【语义等价】于逐行 SELECT。
//     · 冲突 SELECT 由内存 Map 直接回答（不发起 HTTP），判定规则与 importer 完全一致。
//     · UPSERT batch 合并为单条 `INSERT OR IGNORE ... VALUES (…),(…),…`
//       依赖 0046 已恢复的全局 UNIQUE(code) 保证幂等，一次 HTTP 完成一个 batch。
//     · inserted / alreadyPresent 由「batch 前已存在与否」精确推导，不依赖逐行 changes。
//
// 硬约束：
//   - 显式 target 必填；account / dbUuid 守卫在此层强制；禁止默认 DB 回退。
//   - 绝不打印 raw code / PII / token。
// =============================================================================
import { DatabaseSync } from 'node:sqlite';

/** importer 使用的冲突检测 SELECT（用于识别并改由内存 Map 回答）。 */
export const CONFLICT_SELECT_RE =
  /^\s*SELECT\s+pool_type,\s*status,\s*provenance\s+FROM\s+id_pools\s+WHERE\s+code\s*=\s*\?\s*$/i;

/** importer 使用的幂等 UPSERT（用于识别并合并为多值 INSERT OR IGNORE）。 */
export const UPSERT_RE =
  /^\s*INSERT\s+INTO\s+id_pools\s*\(([^)]*)\)\s*SELECT\s+\?,\s*\?,\s*\?,\s*\?,\s*\?,\s*\?,\s*\?,\s*\?\s*WHERE\s+NOT\s+EXISTS\s*\(/i;

export const ID_POOLS_COLUMNS = [
  'pool_type',
  'code',
  'status',
  'assigned_to',
  'assigned_at',
  'batch_id',
  'provenance',
  'created_at',
];

/** SQL 字面量转义（单引号翻倍；NULL / 数值原样）。 */
export function sqlLiteral(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

// -----------------------------------------------------------------------------
// 1) 本地 SQLite 适配器
// -----------------------------------------------------------------------------

/**
 * @param {{ path?: string, existingRows?: Array<object> }} opts
 *   path 缺省为内存库（`:memory:`）。
 */
export function createLocalSqliteD1({ path = ':memory:', schema } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = OFF;');
  if (schema) db.exec(schema);

  function prepare(sql) {
    let stmt;
    try {
      stmt = db.prepare(sql);
    } catch (e) {
      throw new Error(`LOCAL_SQLITE_PREPARE_FAILED: ${String(e?.message ?? e)}`);
    }
    return {
      bind(...args) {
        return {
          __sql: sql,
          __params: args,
          async run() {
            const r = stmt.run(...args);
            return { meta: { changes: Number(r?.changes ?? 0) } };
          },
          async all() {
            const rows = stmt.all(...args);
            return { results: rows ?? [] };
          },
          async first() {
            const r = stmt.get(...args);
            return r ?? null;
          },
        };
      },
    };
  }

  return {
    __kind: 'local-sqlite',
    raw: db,
    prepare,
    async batch(stmts) {
      db.exec('BEGIN');
      const out = [];
      try {
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* noop */ }
        throw e;
      }
      return out;
    },
  };
}

/** 0046 之后的 id_pools 建表语句（本地模拟用，与迁移等价）。 */
export const ID_POOLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS id_pools (
  id          INTEGER PRIMARY KEY,
  pool_type   TEXT NOT NULL CHECK (pool_type IN ('cert_trn','cert_srv','cert_hon','cert_skl','volunteer')),
  code        TEXT NOT NULL,
  status      INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2)),
  assigned_to INTEGER,
  assigned_at INTEGER,
  batch_id    INTEGER,
  provenance  TEXT CHECK (provenance IS NULL OR provenance IN ('legacy_migrated','v2_synthetic_compat','v2_native')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (code)
);
`;

// -----------------------------------------------------------------------------
// 2) 远程 D1 适配器
// -----------------------------------------------------------------------------

export class D1RemoteError extends Error {
  constructor(message, { status, transient } = {}) {
    super(message);
    this.name = 'D1RemoteError';
    this.status = status;
    this.transient = transient ?? (/ETIMEDOUT|ECONNRESET|timeout|rate/i.test(String(message)) || (status != null && status >= 500));
  }
}

/**
 * @param {{
 *   accountId: string, dbUuid: string, dbName?: string,
 *   apiToken: string, fetchImpl?: typeof fetch, endpointBase?: string,
 * }} opts
 */
export function createRemoteD1Adapter({
  accountId,
  dbUuid,
  dbName,
  apiToken,
  fetchImpl = globalThis.fetch,
  endpointBase = 'https://api.cloudflare.com/client/v4',
}) {
  if (!accountId) throw new Error('REMOTE_D1_ACCOUNT_ID_REQUIRED');
  if (!dbUuid) throw new Error('REMOTE_D1_DB_UUID_REQUIRED');
  if (!apiToken) throw new Error('REMOTE_D1_API_TOKEN_REQUIRED (set CLOUDFLARE_API_TOKEN; never logged)');
  if (typeof fetchImpl !== 'function') throw new Error('REMOTE_D1_FETCH_UNAVAILABLE');

  const url = `${endpointBase}/accounts/${accountId}/d1/database/${dbUuid}/query`;

  /** @type {Map<string, {pool_type:string,status:number,provenance:string|null}>} */
  const existing = new Map();
  let loaded = false;

  async function query(sql, params = []) {
    let resp;
    try {
      resp = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
      });
    } catch (e) {
      throw new D1RemoteError(String(e?.message ?? e), { transient: true });
    }
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new D1RemoteError('D1_RESPONSE_NOT_JSON', { status: resp.status }); }
    if (!resp.ok || json?.success === false) {
      const msg = (json?.errors ?? []).map((e) => String(e?.message ?? e)).join('; ') || `HTTP_${resp.status}`;
      throw new D1RemoteError(msg, { status: resp.status });
    }
    const result = json?.result ?? [];
    const first = Array.isArray(result) ? result[0] : result;
    return { results: first?.results ?? [], meta: first?.meta ?? {} };
  }

  /** 一次性载入既有 id_pools 行到内存（等价于逐行 SELECT，但只发少量分页请求）。 */
  async function loadExisting({ limit = 5000 } = {}) {
    existing.clear();
    let offset = 0;
    for (;;) {
      const { results } = await query(
        'SELECT code, pool_type, status, provenance FROM id_pools LIMIT ? OFFSET ?',
        [limit, offset],
      );
      for (const r of results) {
        existing.set(r.code, {
          pool_type: r.pool_type,
          status: Number(r.status),
          provenance: r.provenance ?? null,
        });
      }
      if (results.length < limit) break;
      offset += results.length;
    }
    loaded = true;
    return existing.size;
  }

  function prepare(sql) {
    const isConflict = CONFLICT_SELECT_RE.test(sql);
    const isUpsert = UPSERT_RE.test(sql);

    return {
      bind(...args) {
        if (isConflict) {
          const code = args[0];
          return {
            __sql: sql,
            __params: args,
            __kind: 'conflict-select',
            __code: code,
            async first() {
              if (!loaded) await loadExisting();
              const hit = existing.get(code);
              return hit ? { ...hit } : null;
            },
            async all() {
              const r = await this.first();
              return { results: r ? [r] : [] };
            },
            async run() { return { meta: { changes: 0 } }; },
          };
        }
        if (isUpsert) {
          // args: pool_type, code, status, assigned_to, assigned_at, batch_id, provenance, created_at, code
          return {
            __sql: sql,
            __params: args,
            __kind: 'upsert',
            __code: args[1],
            async run() {
              if (!loaded) await loadExisting();
              if (existing.has(args[1])) return { meta: { changes: 0 } };
              const values = `(${ID_POOLS_COLUMNS.map((_, i) => sqlLiteral(args[i])).join(',')})`;
              await query(
                `INSERT OR IGNORE INTO id_pools (${ID_POOLS_COLUMNS.join(',')}) VALUES ${values}`,
              );
              // 内存态同步，保证后续冲突判定与续跑一致
              existing.set(args[1], {
                pool_type: args[0],
                status: Number(args[2]),
                provenance: args[6] ?? null,
              });
              return { meta: { changes: 1 } };
            },
            async all() { return { results: [] }; },
            async first() { return null; },
          };
        }
        // 其它语句（如 PRAGMA / 计数）直连
        return {
          __sql: sql,
          __params: args,
          __kind: 'generic',
          async run() { return { meta: await query(sql, args) }; },
          async all() { return query(sql, args); },
          async first() {
            const { results } = await query(sql, args);
            return results[0] ?? null;
          },
        };
      },
    };
  }

  /**
   * batch：把同一批 UPSERT 合并为单条多值 INSERT OR IGNORE（一次 HTTP）。
   * 返回值保持 importer 期望的逐条形状（meta.changes 0/1，精确）。
   */
  async function batch(stmts) {
    if (!loaded) await loadExisting();
    const upserts = stmts.filter((s) => s.__kind === 'upsert');
    const others = stmts.filter((s) => s.__kind !== 'upsert');

    const outcomes = new Map();
    if (upserts.length > 0) {
      const fresh = upserts.filter((s) => !existing.has(s.__code));
      for (const s of upserts) outcomes.set(s, existing.has(s.__code) ? 0 : 1);

      // 分批写入，避免单条 SQL 过大
      const CHUNK = 1000;
      for (let i = 0; i < fresh.length; i += CHUNK) {
        const part = fresh.slice(i, i + CHUNK);
        const values = part
          .map((s) => `(${ID_POOLS_COLUMNS.map((_, k) => sqlLiteral(s.__params[k])).join(',')})`)
          .join(',');
        await query(`INSERT OR IGNORE INTO id_pools (${ID_POOLS_COLUMNS.join(',')}) VALUES ${values}`);
      }
      for (const s of fresh) {
        existing.set(s.__code, {
          pool_type: s.__params[0],
          status: Number(s.__params[2]),
          provenance: s.__params[6] ?? null,
        });
      }
    }

    const out = [];
    for (const s of stmts) {
      if (s.__kind === 'upsert') out.push({ meta: { changes: outcomes.get(s) ?? 0 } });
      else out.push(await s.run());
    }
    void others;
    return out;
  }

  return {
    __kind: 'remote-d1',
    __dbName: dbName,
    __dbUuid: dbUuid,
    prepare,
    batch,
    loadExisting,
    get existingSize() { return existing.size; },
  };
}
