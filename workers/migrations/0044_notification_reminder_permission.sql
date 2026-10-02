-- =============================================================================
-- P11-WP4 安全收口 — 0044：补录 notification.reminder.trigger 权限
--
-- 问题（安全扫描发现，真实 BLOCKER）：
--   routes/notifications-wechat.ts 要求 requirePermission('notification.reminder.trigger')，
--   但该权限此前从未写入权限目录 / 迁移种子。生产环境命中该端点时，
--   authorizePermissionDecision → isKnownPermission 返回 false → unknown_permission
--   → 所有平台管理员触发「开始提醒」均返回 HTTP 500（功能完全不可用）。
--
-- 修复：
--   - 在 permissions 目录新增 notification.reminder.trigger（PLATFORM / MEDIUM=2），
--     与 notification.template.manage 同域同风险档。
--   - 授予 platform_super_admin 与 platform_operator（平台级触发，teamId=null）。
--
-- 纪律（沿用 0041/0042 单权限迁移范式）：
--   - 仅 INSERT OR IGNORE 新增权限；
--   - 仅 INSERT OR IGNORE 两个平台角色绑定；
--   - 不修改任何既有权限 / 历史迁移 / schema / 业务表。
--   - 幂等：可安全重复执行（apply 失败重试无副作用）。
-- =============================================================================

INSERT OR IGNORE INTO permissions (code, name, perm_group, risk_level)
VALUES ('notification.reminder.trigger', '通知提醒触发（平台级开始提醒）', 'notification', 2);

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
VALUES (
  (SELECT id FROM roles WHERE code = 'platform_super_admin'),
  (SELECT id FROM permissions WHERE code = 'notification.reminder.trigger')
);

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
VALUES (
  (SELECT id FROM roles WHERE code = 'platform_operator'),
  (SELECT id FROM permissions WHERE code = 'notification.reminder.trigger')
);
