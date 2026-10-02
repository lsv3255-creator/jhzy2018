-- 0043_session_device_platform.sql
-- 冻结裁决 P5_FINAL_FREEZE.md §3（2026-09-18）：sessions 必须包含 device / platform 字段（多设备会话管理）。
-- 其余会话字段（ip → 以 ip_hash 隐私化存储；user_agent 已存在）已在 0001 落地，本迁移补齐 device / platform。
-- 兼容本地重复执行：仅当列不存在时添加（SQLite 不支持 ADD COLUMN IF NOT EXISTS，用 pragma 守卫）。

-- device：派生设备/应用标签（如 'WeChat Mini Program' / 'Chrome on Windows' / 'Unknown Device'）。
ALTER TABLE sessions ADD COLUMN device TEXT;

-- platform：派生操作系统标签（如 'iPhone' / 'Android' / 'Windows' / 'Mac' / null）。
ALTER TABLE sessions ADD COLUMN platform TEXT;
