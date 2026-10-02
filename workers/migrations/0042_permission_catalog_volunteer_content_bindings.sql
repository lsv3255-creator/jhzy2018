-- =============================================================================
-- 0042：补齐 catalog 已声明但尚未 materialize 的 volunteer 内容权限绑定
--
-- 背景（5C.2 验收结论）：
--   scripts/permission-catalog.json（唯一事实源）已声明 volunteer 绑定
--   content.comment.create / content.like.create / content.report.create，
--   但 committed migrations 0001–0041 与 local D1 尚未包含这 3 个绑定。
--   migrations（104/292）与 local D1（104/292）完全一致；catalog（104/295）多 3 个。
--
-- 目标（5D 授权）：
--   将 catalog 目标 104/295 在数据库侧 materialize：
--   仅新增 volunteer 的 3 个绑定，使最终集合 = 104 permissions / 295 role_permissions。
--
-- 约束（绝对边界）：
--   - 仅 INSERT OR IGNORE 三个 volunteer 绑定；
--   - permission code 已存在（platform_super_admin 已持有），仅补 volunteer 绑定，不新增 permission code；
--   - 不修改 roles、不删除任何既有绑定、不修改其他角色、不回改 0003、不修改 catalog；
--   - DO NOT MODIFY 0001–0041（历史迁移冻结）；
--   - 幂等安全（INSERT OR IGNORE + 子查询依赖已存在 code）。
-- =============================================================================

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
VALUES (
  (SELECT id FROM roles WHERE code = 'volunteer'),
  (SELECT id FROM permissions WHERE code = 'content.comment.create')
);

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
VALUES (
  (SELECT id FROM roles WHERE code = 'volunteer'),
  (SELECT id FROM permissions WHERE code = 'content.like.create')
);

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
VALUES (
  (SELECT id FROM roles WHERE code = 'volunteer'),
  (SELECT id FROM permissions WHERE code = 'content.report.create')
);
