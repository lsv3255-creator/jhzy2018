/**
 * CertificateRepository（P32-P2）—— certificate_templates / certificates / certificate_logs / id_pools。
 *
 * scope 事实（S2-3 矩阵 / tenant-scope.ts）：
 * - certificate_templates = PLATFORM_GLOBAL（模板，admin 维护）
 * - certificates / certificate_logs = TEAM_SCOPED（含 team_id；平台证书归 platform_root）
 * - id_pools = PLATFORM_GLOBAL（编号池；cert_trn pool_type）
 *
 * 只读端点（mine / detail / verify）在此；发证原子写由 ExamRepository.submitAndMaybeIssueAtomically
 * 直接使用本类提供的模板/号池解析能力 + id_pool SELECT（对池子只做只读探测，消费在 exam batch 内）。
 */

import { BaseRepository, type RepoDeps } from './base';
import { generateUlid } from '../utils/crypto';
import { allocatableProvenanceSql } from '../domain/certificate';

export interface CertificateTemplateRow {
  id: number;
  public_id: string;
  name: string;
  cert_type: string;
  layout: string;
  bg_file_id: number | null;
  status: number;
  created_by: number | null;
  created_at: number;
  updated_at: number | null;
  deleted_at: number | null;
}

export interface CertificateRow {
  id: number;
  public_id: string;
  cert_no: string;
  verify_code: string;
  template_id: number;
  user_id: number;
  team_id: number;
  cert_type: string;
  source_type: string | null;
  source_id: number | null;
  exam_paper_id: number | null;
  holder_name: string | null;
  issuer_name: string | null;
  snapshot: string | null;
  file_id: number | null;
  issued_at: number;
  status: number;
  created_at: number;
  updated_at: number | null;
}

export interface CertificateLogRow {
  id: number;
  team_id: number;
  certificate_id: number;
  action: string;
  reason: string | null;
  operator_id: number | null;
  created_at: number;
}

export interface CertificateInput {
  name: string;
  cert_type: string;
  layout: Record<string, unknown>;
  status?: number;
}

// ===== 对外视图（zero numeric FK / zero id_card / zero PII）=====

export interface CertificateListView {
  public_id: string;
  cert_no: string;
  cert_type: string;
  holder_name: string | null;
  issuer_name: string | null;
  issued_at: number;
  status: number;
  source_type: string | null;
  source_public_id: string | null; // exam session public_id（若 source_type=exam）
  activity_public_id: string | null;
  course_public_id: string | null;
}

export interface CertificateDetailView extends CertificateListView {
  verify_code: string;
  snapshot: string | null;
  cert_no_masked?: string;
}

export interface CertificateVerifyView {
  valid: boolean;
  cert_no: string;
  cert_type: string;
  holder_name: string | null;
  issuer_name: string | null;
  issued_at: number;
  status: number;
}

export class CertificateRepository extends BaseRepository {
  constructor(deps: RepoDeps) {
    super(deps);
  }

  // ===== templates =====

  async findTrainingTemplate(): Promise<CertificateTemplateRow | null> {
    this.ensureTableRead('certificate_templates');
    return this.first<CertificateTemplateRow>(
      `SELECT * FROM certificate_templates WHERE cert_type = 'training' AND status = 1 AND deleted_at IS NULL
        ORDER BY id ASC LIMIT 1`,
      [],
    );
  }

  async listTemplates(): Promise<CertificateTemplateRow[]> {
    this.ensureTableRead('certificate_templates');
    return this.all<CertificateTemplateRow>(
      `SELECT * FROM certificate_templates WHERE deleted_at IS NULL ORDER BY id ASC`,
      [],
    );
  }

  async findTemplateByPublicId(templatePublicId: string): Promise<CertificateTemplateRow | null> {
    this.ensureTableRead('certificate_templates');
    return this.first<CertificateTemplateRow>(
      `SELECT * FROM certificate_templates WHERE public_id = ? AND deleted_at IS NULL`,
      [templatePublicId],
    );
  }

  async adminCreateTemplate(cmd: CertificateInput, createdBy: number, now: number): Promise<{ public_id: string }> {
    this.ensureTableRead('certificate_templates');
    const publicId = generateUlid();
    await this.run(
      `INSERT INTO certificate_templates (public_id, name, cert_type, layout, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [publicId, cmd.name, cmd.cert_type, JSON.stringify(cmd.layout), cmd.status ?? 1, createdBy, now, now],
    );
    return { public_id: publicId };
  }

  async adminUpdateTemplate(templatePublicId: string, cmd: CertificateInput, now: number): Promise<boolean> {
    this.ensureTableRead('certificate_templates');
    const res = await this.run(
      `UPDATE certificate_templates
          SET name = ?, cert_type = ?, layout = ?, status = ?, updated_at = ?
        WHERE public_id = ?`,
      [cmd.name, cmd.cert_type, JSON.stringify(cmd.layout), cmd.status ?? 1, now, templatePublicId],
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  // ===== certificates =====

  async findCertByPublicId(publicId: string): Promise<CertificateRow | null> {
    this.ensureTableRead('certificates');
    return this.first<CertificateRow>(`SELECT * FROM certificates WHERE public_id = ?`, [publicId]);
  }

  async findCertByCertNo(certNo: string): Promise<CertificateRow | null> {
    this.ensureTableRead('certificates');
    return this.first<CertificateRow>(`SELECT * FROM certificates WHERE cert_no = ?`, [certNo]);
  }

  async hasActiveTrainingCert(userId: number, examPaperId: number): Promise<boolean> {
    this.ensureTableRead('certificates');
    const r = await this.first<{ n: number }>(
      `SELECT COUNT(*) n FROM certificates WHERE user_id = ? AND exam_paper_id = ? AND status = 1`,
      [userId, examPaperId],
    );
    return (r?.n ?? 0) > 0;
  }

  async listCertsByUser(userId: number): Promise<CertificateListView[]> {
    this.ensureTableRead('certificates');
    return this.all<CertificateListView>(
      `SELECT c.public_id, c.cert_no, c.cert_type, c.holder_name, c.issuer_name,
              c.issued_at, c.status, c.source_type,
              es.public_id AS source_public_id,
              a.public_id  AS activity_public_id,
              cu.public_id AS course_public_id
         FROM certificates c
         LEFT JOIN exam_sessions es ON es.id = c.source_id AND c.source_type = 'exam'
         LEFT JOIN activities a     ON a.id = c.source_id AND c.source_type = 'activity'
         LEFT JOIN courses cu       ON cu.id = c.source_id AND c.source_type = 'course'
        WHERE c.user_id = ?
        ORDER BY c.issued_at DESC`,
      [userId],
    );
  }

  /** 单张证书详情（含 verify_code，仅供持证者本人 / 团队管理员）。 */
  async getCertDetailByPublicId(publicId: string): Promise<(CertificateRow & CertificateDetailView) | null> {
    const row = await this.findCertByPublicId(publicId);
    if (!row) return null;
    const source = await this.resolveSourcePublicId(row);
    return {
      ...row,
      verify_code: row.verify_code,
      source_public_id: source.sourcePublicId,
      activity_public_id: source.activityPublicId,
      course_public_id: source.coursePublicId,
    };
  }

  private async resolveSourcePublicId(
    row: CertificateRow,
  ): Promise<{ sourcePublicId: string | null; activityPublicId: string | null; coursePublicId: string | null }> {
    if (row.source_type === 'exam' && row.source_id != null) {
      const r = await this.first<{ public_id: string }>(
        `SELECT public_id FROM exam_sessions WHERE id = ?`,
        [row.source_id],
      );
      return { sourcePublicId: r?.public_id ?? null, activityPublicId: null, coursePublicId: null };
    }
    if (row.source_type === 'activity' && row.source_id != null) {
      const r = await this.first<{ public_id: string }>(
        `SELECT public_id FROM activities WHERE id = ?`,
        [row.source_id],
      );
      return { sourcePublicId: null, activityPublicId: r?.public_id ?? null, coursePublicId: null };
    }
    if (row.source_type === 'course' && row.source_id != null) {
      const r = await this.first<{ public_id: string }>(
        `SELECT public_id FROM courses WHERE id = ?`,
        [row.source_id],
      );
      return { sourcePublicId: null, activityPublicId: null, coursePublicId: r?.public_id ?? null };
    }
    return { sourcePublicId: null, activityPublicId: null, coursePublicId: null };
  }

  /** 公开验真（仅安全字段）。 */
  async verifyCert(certNo: string, verifyCode?: string): Promise<CertificateVerifyView | null> {
    this.ensureTableRead('certificates');
    let row: CertificateRow | null;
    if (verifyCode != null && verifyCode !== '') {
      row = await this.first<CertificateRow>(
        `SELECT * FROM certificates WHERE verify_code = ?`,
        [verifyCode],
      );
    } else {
      row = await this.findCertByCertNo(certNo);
    }
    if (!row) return null;
    return {
      valid: row.status === 1,
      cert_no: row.cert_no,
      cert_type: row.cert_type,
      holder_name: row.holder_name,
      issuer_name: row.issuer_name,
      issued_at: row.issued_at,
      status: row.status,
    };
  }

  // ===== id_pools（只读探测；消费在 exam 原子 batch 内完成）=====

  /**
   * TRAINING（cert_trn）候选编号探测 —— 【唯一权威的 cert_trn 选择点】。
   *
   * CERT-R3D-FIX §9/§10：候选必须同时满足
   *   1) pool_type = 'cert_trn'
   *   2) status = 0（free）
   *   3) provenance ∈ ALLOCATABLE_PROVENANCES（= 'legacy_migrated' | 'v2_native'）
   *
   * 条件 3 是必需的：合成兼容库存（provenance='v2_synthetic_compat'）的 id 远小于
   * legacy 行，仅按 (1)(2) 会让 TRAINING 先消费兼容库存，违反冻结决策
   * NUMBER_FORMAT_POLICY = PRESERVE_LEGACY_FORMATS。
   *
   * 显式存储语义，不从 code 前缀/长度/正则推断（那正是本缺陷的成因）。
   * `ORDER BY id ASC` 仅作为【合格集合内部】的确定性定序，不承担语义优先级。
   *
   * 消费侧（exam.ts 的条件 UPDATE）使用同一谓词片段，保证选择与烧号一致。
   */
  async pickCertTrnCandidate(): Promise<string | null> {
    this.ensureTableRead('id_pools');
    const r = await this.first<{ code: string }>(
      `SELECT code FROM id_pools
        WHERE pool_type = 'cert_trn' AND status = 0
          AND ${allocatableProvenanceSql()}
        ORDER BY id ASC LIMIT 1`,
      [],
    );
    return r?.code ?? null;
  }

  // ===== certificate_logs（只读，验证发证链）=====

  async countIssueLogs(certificateId: number): Promise<number> {
    this.ensureTableRead('certificate_logs');
    const r = await this.first<{ n: number }>(
      `SELECT COUNT(*) n FROM certificate_logs WHERE certificate_id = ? AND action = 'issue'`,
      [certificateId],
    );
    return r?.n ?? 0;
  }

  // ===== admin list（certificate.certificate.view 由 route 层授权）=====

  async countCertsByTeam(teamId: number): Promise<number> {
    this.ensureTableRead('certificates');
    const r = await this.first<{ n: number }>(
      `SELECT COUNT(*) n FROM certificates WHERE team_id = ?`,
      [teamId],
    );
    return r?.n ?? 0;
  }

  /**
   * 管理端培训证书列表（TEAM_SCOPED）。仅安全字段（public_id + holder_name/nickname），
   * 绝不暴露 id_card / numeric id / verify_code / snapshot。score 仅当 source_type='exam' 时关联。
   */
  async listCertsByTeam(
    teamId: number,
    page: number,
    pageSize: number,
  ): Promise<
    Array<{
      public_id: string;
      cert_no: string;
      cert_type: string;
      holder_name: string | null;
      holder_public_id: string | null;
      holder_nickname: string | null;
      issuer_name: string | null;
      issued_at: number;
      status: number;
      source_type: string | null;
      source_public_id: string | null;
      activity_public_id: string | null;
      course_public_id: string | null;
      score: number | null;
    }>
  > {
    this.ensureTableRead('certificates');
    const offset = (page - 1) * pageSize;
    return this.all(
      `SELECT c.public_id, c.cert_no, c.cert_type, c.holder_name, c.issuer_name,
              c.issued_at, c.status, c.source_type,
              u.public_id  AS holder_public_id,
              u.nickname   AS holder_nickname,
              es.public_id AS source_public_id,
              a.public_id  AS activity_public_id,
              cu.public_id AS course_public_id,
              es.score     AS score
         FROM certificates c
         LEFT JOIN users u          ON u.id = c.user_id
         LEFT JOIN exam_sessions es ON es.id = c.source_id AND c.source_type = 'exam'
         LEFT JOIN activities a     ON a.id = c.source_id AND c.source_type = 'activity'
         LEFT JOIN courses cu       ON cu.id = c.source_id AND c.source_type = 'course'
        WHERE c.team_id = ?
        ORDER BY c.issued_at DESC
        LIMIT ? OFFSET ?`,
      [teamId, pageSize, offset],
    );
  }
}

export default CertificateRepository;