/**
 * ExamRepository（P32-P2）—— exam_questions / exam_papers / exam_sessions / exam_answers。
 *
 * scope 事实（S2-3 矩阵 / tenant-scope.ts）：
 * - exam_questions   = PLATFORM_GLOBAL（题库，admin 维护；start 时按 pick_rule 抽取）
 * - exam_papers      = TEAM_SCOPED（含 team_id）
 * - exam_sessions    = TEAM_SCOPED（含 team_id）
 * - exam_answers     = TEAM_SCOPED（含 team_id；question FK 指向 PLATFORM_GLOBAL 题库）
 *
 * 既有 D1 纪律（§P32-P1D）：
 * - db.batch 单事务顺序执行；只有真实 SQL 错误才回滚，changes=0 不回滚。
 * - 故所有"条件性 finalize"用【INSERT...SELECT 谓词 / 条件 UPDATE guard / 子查询 EXISTS】
 *   在同一 batch 内表达不变量；POST-batch changes 仅用于应答分类，不用于回滚。
 * - public_id 一律 ULID；attempt 唯一 / 单活跃 attempt 由 0022 唯一索引 DB 终裁。
 */

import { BaseRepository, type RepoDeps } from './base';
import { generateUlid } from '../utils/crypto';
import { invalidParam, conflict, ConflictReason } from '../utils/errors';
import { allocatableProvenanceSql } from '../domain/certificate';
import type { D1PreparedStatement } from '@cloudflare/workers-types';

const UNIQUE_VIOLATION_RE = /unique\s+constraint\s+failed/i;

/**
 * P0-C 冻结：INITIAL_VOLUNTEER 资格试卷的数据/业务不变量。
 * - purpose 标记仅允许 '' | 'INITIAL_VOLUNTEER'（列 CHECK 亦约束）。
 * - 凡持久化为 INITIAL_VOLUNTEER 的试卷，pass_score 恒为 90（本 repo 写入路径强制；
 *   迁移 0033 的 BEFORE 触发器在 DB 层拒绝不一致写入，见 0033）。
 * 不影响全局默认 60 与普通（非 INITIAL）试卷。
 */
const INITIAL_VOLUNTEER_PURPOSE = 'INITIAL_VOLUNTEER';
const INITIAL_VOLUNTEER_PASS_SCORE = 90;

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return UNIQUE_VIOLATION_RE.test(msg);
}

// ===== 行类型 =====

export interface ExamQuestionRow {
  id: number;
  public_id: string;
  question_type: string;
  stem: string;
  options: string; // JSON [{key,text}]
  answer: string;
  analysis: string | null;
  difficulty: number;
  tags: string | null;
  status: number;
  created_by: number | null;
  created_at: number;
  updated_at: number | null;
  deleted_at: number | null;
}

export interface ExamPaperRow {
  id: number;
  public_id: string;
  team_id: number;
  title: string;
  course_id: number | null;
  pick_rule: string; // JSON
  total_score: number;
  pass_score: number;
  duration_min: number;
  max_attempts: number;
  status: number;
  purpose: string; // '' | 'INITIAL_VOLUNTEER'（P0-C 资格标记；唯一性由 uq_exam_papers_initial_volunteer 保证）
  created_at: number;
  updated_at: number | null;
  deleted_at: number | null;
}

export interface ExamSessionRow {
  id: number;
  public_id: string;
  paper_id: number;
  user_id: number;
  team_id: number;
  attempt_no: number;
  started_at: number;
  submitted_at: number | null;
  score: number | null;
  passed: number | null;
  status: number;
  blur_count: number;
  snapshot: string | null;
  created_at: number;
  updated_at: number | null;
}

export interface ExamAnswerRow {
  id: number;
  team_id: number;
  session_id: number;
  question_id: number;
  user_answer: string | null;
  is_correct: number | null;
  score: number | null;
  answered_at: number | null;
}

// ===== 写命令（Admin）=====

export interface ExamQuestionInput {
  question_type: string;
  stem: string;
  options: Array<{ key: string; text: string }>;
  answer: string;
  analysis?: string | null;
  difficulty?: number;
  tags?: string | null;
  status?: number;
}

export interface ExamPaperInput {
  title: string;
  course_id?: number | null;
  /** 管理端用 course_public_id 关联课程；后端解析为 numeric course_id（绝不依赖客户端传 numeric id）。 */
  course_public_id?: string | null;
  pick_rule: Record<string, unknown>;
  total_score?: number;
  pass_score?: number;
  duration_min?: number;
  max_attempts?: number;
  status?: number;
  /** P0-C 资格标记：''（普通）| 'INITIAL_VOLUNTEER'（初始必训资格试卷）。 */
  purpose?: string;
}

// ===== 原子 start/submit 返回值 =====

export interface StartOutcome {
  status: 'created' | 'rejoined';
  sessionId: number;
  attemptNo: number;
}

export interface GradedAnswer {
  questionPublicId: string;
  selected: string | null;
  isCorrect: boolean;
  score: number;
}

export interface SubmitOutcome {
  // 0 = 无变化（批内 guard 未命中：已提交 / 跨团队 / 条件不成立）
  // 1 = session 完成（status 1→3）
  sessionChanged: boolean;
  // certificate 本次是否生成（passed && 无 active cert && pool 可用）
  certificateIssued: boolean;
  // 若为 true ⇒ 本次 batch 是 no-op 且 session 仍 IN_PROGRESS（pool 竞争等，需重试）
  retryRequired: boolean;
}

export class ExamRepository extends BaseRepository {
  constructor(deps: RepoDeps) {
    super(deps);
  }



  // ===== questions（PLATFORM_GLOBAL）=====

  async listQuestions(offset: number, limit: number): Promise<ExamQuestionRow[]> {
    this.ensureTableRead('exam_questions');
    return this.all<ExamQuestionRow>(
      `SELECT * FROM exam_questions WHERE status = 1 AND deleted_at IS NULL ORDER BY id ASC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
  }

  async countQuestions(): Promise<number> {
    this.ensureTableRead('exam_questions');
    const r = await this.first<{ n: number }>(
      `SELECT COUNT(*) n FROM exam_questions WHERE status = 1 AND deleted_at IS NULL`,
      [],
    );
    return r?.n ?? 0;
  }

  async findQuestionByPublicId(questionPublicId: string): Promise<ExamQuestionRow | null> {
    this.ensureTableRead('exam_questions');
    return this.first<ExamQuestionRow>(
      `SELECT * FROM exam_questions WHERE public_id = ? AND deleted_at IS NULL`,
      [questionPublicId],
    );
  }

  async adminCreateQuestion(cmd: ExamQuestionInput, createdBy: number, now: number): Promise<{ public_id: string; id: number }> {
    this.ensureTableRead('exam_questions');
    const publicId = generateUlid();
    const res = await this.run(
      `INSERT INTO exam_questions
         (public_id, question_type, stem, options, answer, analysis, difficulty, tags, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        publicId,
        cmd.question_type,
        cmd.stem,
        JSON.stringify(cmd.options),
        cmd.answer,
        cmd.analysis ?? null,
        cmd.difficulty ?? 2,
        cmd.tags ?? null,
        cmd.status ?? 1,
        createdBy,
        now,
        now,
      ],
    );
    return { public_id: publicId, id: Number(res.meta?.last_row_id ?? 0) };
  }

  async adminUpdateQuestion(questionPublicId: string, cmd: ExamQuestionInput, now: number): Promise<boolean> {
    this.ensureTableRead('exam_questions');
    const res = await this.run(
      `UPDATE exam_questions
          SET question_type = ?, stem = ?, options = ?, answer = ?, analysis = ?, difficulty = ?, tags = ?, status = ?, updated_at = ?
        WHERE public_id = ?`,
      [
        cmd.question_type,
        cmd.stem,
        JSON.stringify(cmd.options),
        cmd.answer,
        cmd.analysis ?? null,
        cmd.difficulty ?? 2,
        cmd.tags ?? null,
        cmd.status ?? 1,
        now,
        questionPublicId,
      ],
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  /**
   * 按 pick_rule 抽取题目（服务端权威，确定性：ORDER BY id）。
   * rule 形如 { "count": 20, "types": { "single": 15, "judge": 5 }, "difficulty": [1,3], "tags": [...] }
   * count 缺省 = 20。题数不足 / 类型配置不足 → 抛 invalidParam（start 前拒绝，不落半成品）。
   */
  async drawQuestions(rule: Record<string, unknown>): Promise<ExamQuestionRow[]> {
    this.ensureTableRead('exam_questions');
    const countNum = typeof rule.count === 'number' ? rule.count : 20;
    const types = rule.types as Record<string, number> | undefined;
    const difficulty = rule.difficulty as number[] | undefined;
    const tags = rule.tags as string[] | undefined;

    const baseClauses: string[] = [`status = 1`, `deleted_at IS NULL`];
    const baseParams: unknown[] = [];
    if (Array.isArray(difficulty) && difficulty.length === 2) {
      baseClauses.push(`difficulty BETWEEN ? AND ?`);
      baseParams.push(difficulty[0], difficulty[1]);
    }
    if (Array.isArray(tags) && tags.length > 0) {
      baseClauses.push(
        tags.map(() => `(tags IS NOT NULL AND instr(',' || tags || ',', ',' || ? || ',') > 0)`).join(' AND '),
      );
      baseParams.push(...tags);
    }

    let rows: ExamQuestionRow[] = [];
    if (types) {
      // 按类型配额抽取，保持确定性（类型内 ORDER BY id）
      for (const [t, n] of Object.entries(types)) {
        const list = await this.all<ExamQuestionRow>(
          `SELECT * FROM exam_questions
            WHERE status = 1 AND deleted_at IS NULL AND question_type = ?
              AND ${baseClauses.filter((c) => c !== 'status = 1').join(' AND ')}
            ORDER BY id ASC LIMIT ?`,
          [t, ...baseParams, n],
        );
        rows = rows.concat(list);
      }
      if (rows.length < countNum) {
        throw invalidParam('pick_rule', 'insufficient questions for required types');
      }
    } else {
      rows = await this.all<ExamQuestionRow>(
        `SELECT * FROM exam_questions WHERE ${baseClauses.join(' AND ')} ORDER BY id ASC LIMIT ?`,
        [...baseParams, countNum],
      );
      if (rows.length < countNum) {
        throw invalidParam('pick_rule', 'insufficient questions in bank');
      }
    }
    return rows.slice(0, countNum);
  }

  // ===== papers（TEAM_SCOPED）=====

  async findPaperById(paperId: number): Promise<ExamPaperRow | null> {
    this.ensureTableRead('exam_papers');
    return this.first<ExamPaperRow>(`SELECT * FROM exam_papers WHERE id = ?`, [paperId]);
  }

  async findPaperByPublicId(teamId: number, paperPublicId: string): Promise<ExamPaperRow | null> {
    this.ensureTableRead('exam_papers');
    return this.first<ExamPaperRow>(
      `SELECT * FROM exam_papers WHERE team_id = ? AND public_id = ? AND deleted_at IS NULL`,
      [teamId, paperPublicId],
    );
  }

  /**
   * 管理端试卷列表（TEAM_SCOPED）。仅返回安全公开字段：
   * course_public_id（关联课程的 public_id）+ course_title，绝不暴露 numeric course_id / paper id。
   */
  async listPapersByTeam(
    teamId: number,
  ): Promise<
    Array<{
      public_id: string;
      title: string;
      course_public_id: string | null;
      course_title: string | null;
      pick_rule: string;
      total_score: number;
      pass_score: number;
      duration_min: number;
      max_attempts: number;
      status: number;
      created_at: number;
    }>
  > {
    this.ensureTableRead('exam_papers');
    return this.all(
      `SELECT ep.public_id, ep.title,
              c.public_id  AS course_public_id,
              c.title      AS course_title,
              ep.pick_rule, ep.total_score, ep.pass_score, ep.duration_min, ep.max_attempts, ep.status, ep.created_at
         FROM exam_papers ep
         LEFT JOIN courses c ON c.id = ep.course_id AND c.deleted_at IS NULL
        WHERE ep.team_id = ? AND ep.deleted_at IS NULL
        ORDER BY ep.created_at DESC`,
      [teamId],
    );
  }

  /**
   * 志愿者考试发现（P32-P3A）：按 course_id 取「当前团队下、已发布(active, status=1)」的试卷。
   * 一课可能多卷（exam_papers.course_id 无唯一约束），确定性取「最近创建」的 active paper。
   * 找不到 → null（前端据此显示「不可考 / 暂无考试」而非 500）。
   * 只返回 public_id 与状态判定，绝不暴露 numeric paper id，不含题目/答案。
   */
  async findActivePaperByCourseId(teamId: number, courseId: number): Promise<ExamPaperRow | null> {
    this.ensureTableRead('exam_papers');
    return this.first<ExamPaperRow>(
      `SELECT * FROM exam_papers WHERE team_id = ? AND course_id = ? AND status = 1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
      [teamId, courseId],
    );
  }

  async countUserAttempts(userId: number, paperId: number): Promise<number> {
    this.ensureTableRead('exam_sessions');
    const r = await this.first<{ n: number }>(
      `SELECT COUNT(*) n FROM exam_sessions WHERE user_id = ? AND paper_id = ?`,
      [userId, paperId],
    );
    return r?.n ?? 0;
  }

  /** 解析课程 public_id → numeric id（TEAM_SCOPED）。找不到返回 null。 */
  async findCourseIdByPublicId(teamId: number, coursePublicId: string): Promise<number | null> {
    this.ensureTableRead('courses');
    const r = await this.first<{ id: number }>(
      `SELECT id FROM courses WHERE team_id = ? AND public_id = ? AND deleted_at IS NULL`,
      [teamId, coursePublicId],
    );
    return r ? r.id : null;
  }

  async adminCreatePaper(teamId: number, cmd: ExamPaperInput, now: number): Promise<{ public_id: string }> {
    this.ensureTableRead('exam_papers');
    const courseId = cmd.course_public_id
      ? await this.findCourseIdByPublicId(teamId, cmd.course_public_id)
      : (cmd.course_id ?? null);
    const purpose = cmd.purpose === INITIAL_VOLUNTEER_PURPOSE ? INITIAL_VOLUNTEER_PURPOSE : '';
    // P0-C 不变量：INITIAL_VOLUNTEER 资格试卷及格线恒为 90（忽略入参；不改变全局默认 60）。
    const passScore =
      purpose === INITIAL_VOLUNTEER_PURPOSE ? INITIAL_VOLUNTEER_PASS_SCORE : (cmd.pass_score ?? 60);
    const publicId = generateUlid();
    await this.run(
      `INSERT INTO exam_papers
         (public_id, team_id, title, course_id, pick_rule, total_score, pass_score, duration_min, max_attempts, status, created_at, updated_at, purpose)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        publicId,
        teamId,
        cmd.title,
        courseId,
        JSON.stringify(cmd.pick_rule),
        cmd.total_score ?? 100,
        passScore,
        cmd.duration_min ?? 60,
        cmd.max_attempts ?? 3,
        cmd.status ?? 1,
        now,
        now,
        purpose,
      ],
    );
    return { public_id: publicId };
  }

  async adminUpdatePaper(teamId: number, paperPublicId: string, cmd: ExamPaperInput, now: number): Promise<boolean> {
    this.ensureTableRead('exam_papers');
    const courseId = cmd.course_public_id
      ? await this.findCourseIdByPublicId(teamId, cmd.course_public_id)
      : (cmd.course_id ?? null);
    const existing = await this.first<{ purpose: string }>(
      `SELECT purpose FROM exam_papers WHERE team_id = ? AND public_id = ?`,
      [teamId, paperPublicId],
    );
    // P0-C 不变量：有效 purpose = 入参（若提供）否则沿用现有；INITIAL_VOLUNTEER 试卷 pass_score 恒为 90
    // （因此「把已标记试卷改成其它 pass_score」被强制回归 90，普通试卷仍取自身值 / 默认 60）。
    const effectivePurpose =
      cmd.purpose != null
        ? (cmd.purpose === INITIAL_VOLUNTEER_PURPOSE ? INITIAL_VOLUNTEER_PURPOSE : '')
        : (existing?.purpose ?? '');
    const passScore =
      effectivePurpose === INITIAL_VOLUNTEER_PURPOSE
        ? INITIAL_VOLUNTEER_PASS_SCORE
        : (cmd.pass_score ?? 60);
    const res = await this.run(
      `UPDATE exam_papers
          SET title = ?, course_id = ?, pick_rule = ?, total_score = ?, pass_score = ?, duration_min = ?, max_attempts = ?, status = ?, purpose = ?, updated_at = ?
        WHERE team_id = ? AND public_id = ?`,
      [
        cmd.title,
        courseId,
        JSON.stringify(cmd.pick_rule),
        cmd.total_score ?? 100,
        passScore,
        cmd.duration_min ?? 60,
        cmd.max_attempts ?? 3,
        cmd.status ?? 1,
        effectivePurpose,
        now,
        teamId,
        paperPublicId,
      ],
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  // ===== sessions =====

  async findSessionByPublicId(teamId: number, sessionPublicId: string): Promise<ExamSessionRow | null> {
    this.ensureTableRead('exam_sessions');
    return this.first<ExamSessionRow>(
      `SELECT * FROM exam_sessions WHERE public_id = ? AND team_id = ?`,
      [sessionPublicId, teamId],
    );
  }

  /** 找该用户+试卷的活跃（IN_PROGRESS）会话（用于 C1 并发 start 的 readback）。 */
  async findActiveSessionByUserPaper(userId: number, paperId: number): Promise<ExamSessionRow | null> {
    this.ensureTableRead('exam_sessions');
    return this.first<ExamSessionRow>(
      `SELECT * FROM exam_sessions WHERE user_id = ? AND paper_id = ? AND status IN (1,2) ORDER BY id DESC LIMIT 1`,
      [userId, paperId],
    );
  }

  /**
   * 原子 start：INSERT exam_session（attempt_no 由 SQL 实时计算）+ 钉入恰好 20 条 exam_answers，
   * 二者同一 db.batch（单事务）。唯一索引（uq_exam_attempt / uq_exam_active_attempt）是并发终裁。
   *
   * onMaster：
   * - 若已有活跃会话（并发 start 输家），return { status:'rejoined', existing }。
   * - 若本次 INSERT 命中唯一约束（竞争）→ 读回活跃会话 → rejoined；读不到 → conflict。
   */
  async startSessionAtomically(
    paperId: number,
    teamId: number,
    userId: number,
    questionRows: ExamQuestionRow[],
    now: number,
  ): Promise<StartOutcome & { sessionPublicId: string }> {
    this.ensureTableRead('exam_sessions');
    this.ensureTableRead('exam_answers');
    const existing = await this.findActiveSessionByUserPaper(userId, paperId);
    if (existing) {
      return { status: 'rejoined', sessionId: existing.id, attemptNo: existing.attempt_no, sessionPublicId: existing.public_id };
    }

    const sessionPublicId = generateUlid();
    const statements: { sql: string; params: unknown[] }[] = [];
    statements.push({
      sql: `INSERT INTO exam_sessions
              (public_id, paper_id, user_id, team_id, attempt_no, started_at, status, snapshot, created_at, updated_at)
            VALUES
              (?, ?, ?, ?,
               COALESCE((SELECT MAX(attempt_no) FROM exam_sessions WHERE user_id = ? AND paper_id = ?), 0) + 1,
               ?, 1, ?, ?, ?)`,
      params: [
        sessionPublicId,
        paperId,
        userId,
        teamId,
        userId,
        paperId,
        now,
        JSON.stringify({
          paperPublicId: (await this.getPaperPublicId(paperId)) ?? null,
          questions: questionRows.map((q) => ({
            publicId: q.public_id,
            order: q.id,
            stem: q.stem,
            options: JSON.parse(q.options),
          })),
          count: questionRows.length,
        }),
        now,
        now,
      ],
    });
    // 钉入 20 条 answer 行（question key 由 SQL 从刚插入的 session 派生，read-your-writes）
    for (const q of questionRows) {
      statements.push({
        sql: `INSERT INTO exam_answers (team_id, session_id, question_id, answered_at)
              VALUES (?, (SELECT id FROM exam_sessions WHERE public_id = ?), ?, NULL)`,
        params: [teamId, sessionPublicId, q.id],
      });
    }
    let batchFailedByUnique = false;
    try {
      await this.db.batch(
        statements.map((s) => this.db.prepare(s.sql).bind(...(s.params as never[]))),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        batchFailedByUnique = true;
      } else {
        console.error('[P32-DEBUG] batch error:', err instanceof Error ? err.message : String(err));
        throw err;
      }
    }
    if (batchFailedByUnique) {
      const active = await this.findActiveSessionByUserPaper(userId, paperId);
      if (active) return { status: 'rejoined', sessionId: active.id, attemptNo: active.attempt_no, sessionPublicId: active.public_id };
      throw conflict(ConflictReason.EXAM_ACTIVE_ATTEMPT_CONFLICT);
    }
    const session = await this.findSessionByPublicId(teamId, sessionPublicId);
    if (!session) {
      const active = await this.findActiveSessionByUserPaper(userId, paperId);
      if (active) return { status: 'rejoined', sessionId: active.id, attemptNo: active.attempt_no, sessionPublicId: active.public_id };
      throw conflict(ConflictReason.EXAM_ACTIVE_ATTEMPT_CONFLICT);
    }
    return { status: 'created', sessionId: session.id, attemptNo: session.attempt_no, sessionPublicId };
  }

  private async getPaperPublicId(paperId: number): Promise<string | null> {
    const r = await this.first<{ public_id: string }>(`SELECT public_id FROM exam_papers WHERE id = ?`, [paperId]);
    return r?.public_id ?? null;
  }

  // ===== submit / grade：原子 batch =====

  /** 取 session 钉住的题目（JOIN exam_answers → exam_questions），用于 grading 判定集合。 */
  async listPinnedQuestions(sessionId: number, teamId: number): Promise<
    Array<{
      questionId: number;
      questionPublicId: string;
      answer: string;
      question_type: string;
    }>
  > {
    this.ensureTableRead('exam_answers');
    this.ensureTableRead('exam_questions');
    return this.all(
      `SELECT q.id AS questionId, q.public_id AS questionPublicId, q.answer, q.question_type
         FROM exam_answers ea
         JOIN exam_questions q ON q.id = ea.question_id
        WHERE ea.session_id = ? AND ea.team_id = ?
        ORDER BY ea.id ASC`,
      [sessionId, teamId],
    );
  }

  /**
   * 原子 submit：条件 finalize（answers + session）＋ 条件发证（certificates + log + id_pool）。
   * 不变量在 SQL 内表达（§P32-P1D）：
   *   - answers UPDATE  仅当 session 仍 IN_PROGRESS
   *   - session COMPLETE 仅当 status=1；若 passed=1 且无 active cert 且需号池 ⇒ 追加 pool 可用性条件
   *   - cert INSERT 仅当 passed=1 AND 无 active cert AND pool 可用（SELECT 谓词）
   *   - log INSERT 经 SELECT certificates.id（read-your-writes）
   *   - pool consume 仅当本批 cert 已生成（依赖子查询）
   * changes=0 仅用于应答分类；唯一索引冲突（uq_cert_user_paper / cert_no UNIQUE）会真实回滚整批。
   */
  async submitAndMaybeIssueAtomically(args: {
    sessionId: number;
    sessionPublicId: string;
    teamId: number;
    userId: number;
    paperId: number;
    passed: boolean;
    score: number;
    graded: GradedAnswer[];
    certNoCandidate: string | null; // passed && 需发证时为 pool code；否则 null
    certPublicId: string | null; // passed && 需发证时预生成 ULID
    verifyCode: string | null;
    templateId: number | null;
    snapshotCert: string | null;
    now: number;
    faultCertType?: string; // 仅 local 故障注入（违反 cert_type CHECK）
    faultLogAction?: string; // 仅 local 故障注入（违反 log action CHECK）
  }): Promise<SubmitOutcome> {
    this.ensureTableRead('exam_sessions');
    this.ensureTableRead('exam_answers');
    this.ensureTableRead('certificates');
    this.ensureTableRead('certificate_logs');
    this.ensureTableRead('id_pools');

    const needIssue = args.passed && args.certNoCandidate != null && args.certPublicId != null && args.templateId != null;
    const statements: D1PreparedStatement[] = [];

    // 1) 条件 answers finalize：仅当 session 仍 IN_PROGRESS。
    //    对"新通过且需发证"（needIssue）的提交：答案也必须共享号池/证书不变量——
    //    若号池候选已失效且无 active cert，则答案不得落库（整体 no-op → 重试），
    //    绝不允许"答案已定稿 + 无证书"的中间态（§P32-P2 §11）。
    for (const g of args.graded) {
      const gate = needIssue
        ? `AND (
             EXISTS (SELECT 1 FROM id_pools p
                      WHERE p.pool_type = 'cert_trn' AND p.code = ? AND p.status = 0
                      AND ${allocatableProvenanceSql('p')})
             OR EXISTS (SELECT 1 FROM certificates c
                         WHERE c.user_id = ? AND c.exam_paper_id = ? AND c.status = 1)
           )`
        : '';
      statements.push(
        this.db
          .prepare(
            `UPDATE exam_answers
                SET user_answer = ?, is_correct = ?, score = ?, answered_at = ?
              WHERE session_id = ? AND team_id = ?
                AND question_id = (SELECT id FROM exam_questions WHERE public_id = ?)
                AND EXISTS (SELECT 1 FROM exam_sessions e
                             WHERE e.id = ? AND e.status = 1 AND e.user_id = ? AND e.team_id = ?)
                ${gate}`,
          )
          .bind(
            g.selected,
            g.isCorrect ? 1 : 0,
            g.score,
            args.now,
            args.sessionId,
            args.teamId,
            g.questionPublicId,
            args.sessionId,
            args.userId,
            args.teamId,
            ...(needIssue ? [args.certNoCandidate, args.userId, args.paperId] : []),
          ),
      );
    }

    // 2) 条件 session COMPLETE（1→3）
    if (needIssue) {
      // passed=1 且需发证：session 完成 + cert 生成必须共享「pool 可用性 OR active cert 已存在」，
      // 以及「本批已无 active cert」语义。
      statements.push(
        this.db
          .prepare(
            `UPDATE exam_sessions
                SET status = 3, submitted_at = ?, score = ?, passed = 1, updated_at = ?
              WHERE id = ? AND user_id = ? AND team_id = ? AND status = 1
                AND (
                  EXISTS (SELECT 1 FROM id_pools p
                           WHERE p.pool_type = 'cert_trn' AND p.code = ? AND p.status = 0
                      AND ${allocatableProvenanceSql('p')})
                  OR EXISTS (SELECT 1 FROM certificates c
                              WHERE c.user_id = ? AND c.exam_paper_id = ? AND c.status = 1)
                )`,
          )
          .bind(args.now, args.score, args.now, args.sessionId, args.userId, args.teamId, args.certNoCandidate, args.userId, args.paperId),
      );

      // 3) 条件 cert INSERT（SELECT 谓词：本批已 complete + passed + 无 active cert + pool 可用）
const certType = args.faultCertType ?? 'training';
        console.error('[DEBUG] certType:', certType, 'faultCertType:', args.faultCertType);
        statements.push(
        this.db
          .prepare(
            `INSERT INTO certificates
               (public_id, cert_no, verify_code, template_id, user_id, team_id, cert_type,
                source_type, source_id, exam_paper_id, holder_name, issuer_name, snapshot, status, issued_at, created_at)
             SELECT ?, ?, ?, ?, s.user_id, s.team_id, ?, 'exam', s.id, s.paper_id, NULL, NULL, ?, 1, ?, ?
               FROM exam_sessions s
              WHERE s.id = ? AND s.status = 3 AND s.passed = 1 AND s.user_id = ? AND s.team_id = ?
                AND NOT EXISTS (SELECT 1 FROM certificates x
                                 WHERE x.user_id = ? AND x.exam_paper_id = ? AND x.status = 1)
                AND EXISTS (SELECT 1 FROM id_pools p
                             WHERE p.pool_type = 'cert_trn' AND p.code = ? AND p.status = 0
                      AND ${allocatableProvenanceSql('p')})`,
          )
          .bind(args.certPublicId, args.certNoCandidate, args.verifyCode, args.templateId, certType, args.snapshotCert, args.now, args.now, args.sessionId, args.userId, args.teamId, args.userId, args.paperId, args.certNoCandidate),
      );

      // 4) 条件 certificate_log INSERT（SELECT certificates.id 由本批 public_id 派生；read-your-writes）
      statements.push(
        this.db
          .prepare(
            `INSERT INTO certificate_logs (team_id, certificate_id, action, reason, operator_id, created_at)
             SELECT c.team_id, c.id, ?, NULL, ?, ?
               FROM certificates c
              WHERE c.public_id = ? AND c.status = 1`,
          )
          .bind(args.faultLogAction ?? 'issue', args.userId, args.now, args.certPublicId),
      );

      // 5) 条件 id_pool consume（仅当本批 cert 已生成）
      //    CERT-R3D-FIX §10：消费守卫与 pickCertTrnCandidate 使用【同一】provenance 谓词，
      //    保证「选择」与「烧号」资格规则一致 —— 合成兼容库存永不被烧。
      statements.push(
        this.db
          .prepare(
            `UPDATE id_pools
                SET status = 1, assigned_to = ?, assigned_at = ?
              WHERE pool_type = 'cert_trn' AND code = ? AND status = 0
                AND ${allocatableProvenanceSql()}
                AND EXISTS (SELECT 1 FROM certificates c WHERE c.public_id = ? AND c.status = 1)`,
          )
          .bind(args.userId, args.now, args.certNoCandidate, args.certPublicId),
      );
    } else {
      // passed=0 或已有 active cert（retake 不发第二张）：
      // session COMPLETE 不依赖号池（或已存在 cert → 正常完成）。
      statements.push(
        this.db
          .prepare(
            `UPDATE exam_sessions
                SET status = 3, submitted_at = ?, score = ?, passed = ?, updated_at = ?
              WHERE id = ? AND user_id = ? AND team_id = ? AND status = 1`,
          )
          .bind(args.now, args.score, args.passed ? 1 : 0, args.now, args.sessionId, args.userId, args.teamId),
      );
    }

    const results = await this.db.batch(statements);
    // results[0..n-1] = answers UPDATE changes；随后 session UPDATE。
    const sessionIdx = args.graded.length; // 紧接 answers 之后
    const sessionChanges = Number((results[sessionIdx] as any)?.meta?.changes ?? 0);

    // cert/log/pool 是否生成：cert INSERT 在 session 之后的索引
    const certIdx = sessionIdx + 1; // 仅 needIssue 时存在
    const certChanges = needIssue ? Number((results[certIdx] as any)?.meta?.changes ?? 0) : 0;

    if (sessionChanges === 0) {
      // 批内 session guard 未命中：
      //   - 已 submitted（status=3）→ idempotent replay，返回 200 用已有 result
      //   - pool 竞争（passed=1 需发证但 pool 不可用且无 active cert）→ session 保持 IN_PROGRESS
      const cur = await this.findSessionByPublicId(args.teamId, args.sessionPublicId);
      if (cur && cur.status === 1) {
        return { sessionChanged: false, certificateIssued: false, retryRequired: true };
      }
      return { sessionChanged: false, certificateIssued: false, retryRequired: false };
    }
    return { sessionChanged: true, certificateIssued: certChanges > 0, retryRequired: false };
  }

  // ===== result 读取 =====

  async getSessionResultByPublicId(sessionPublicId: string, teamId: number): Promise<ExamSessionRow | null> {
    return this.findSessionByPublicId(teamId, sessionPublicId);
  }

  async listSessionAnswers(sessionId: number, teamId: number): Promise<
    Array<{ questionPublicId: string; selected: string | null; isCorrect: number | null; score: number | null }>
  > {
    this.ensureTableRead('exam_answers');
    return this.all(
      `SELECT q.public_id AS questionPublicId, ea.user_answer AS selected,
              ea.is_correct AS isCorrect, ea.score
         FROM exam_answers ea
         JOIN exam_questions q ON q.id = ea.question_id
        WHERE ea.session_id = ? AND ea.team_id = ?
        ORDER BY ea.id ASC`,
      [sessionId, teamId],
    );
  }

  // ===== admin result/session list（exam.paper.manage 由 route 层授权）=====

  async countSessionsByTeam(teamId: number): Promise<number> {
    this.ensureTableRead('exam_sessions');
    const r = await this.first<{ n: number }>(
      `SELECT COUNT(*) n FROM exam_sessions WHERE team_id = ?`,
      [teamId],
    );
    return r?.n ?? 0;
  }

  /**
   * 管理端考试结果/会话列表（TEAM_SCOPED）。仅返回安全公开字段（public_id），
   * 绝不暴露 numeric session/paper/user id；holder 仅暴露 users.public_id + nickname。
   */
  async listSessionsByTeam(
    teamId: number,
    page: number,
    pageSize: number,
  ): Promise<
    Array<{
      session_public_id: string;
      paper_public_id: string | null;
      paper_title: string | null;
      user_public_id: string | null;
      user_nickname: string | null;
      status: number;
      attempt_no: number;
      score: number | null;
      passed: number | null;
      started_at: number;
      submitted_at: number | null;
    }>
  > {
    this.ensureTableRead('exam_sessions');
    const offset = (page - 1) * pageSize;
    return this.all(
      `SELECT es.public_id AS session_public_id,
              p.public_id  AS paper_public_id,
              p.title      AS paper_title,
              u.public_id  AS user_public_id,
              u.nickname   AS user_nickname,
              es.status, es.attempt_no, es.score, es.passed, es.started_at, es.submitted_at
         FROM exam_sessions es
         LEFT JOIN exam_papers p ON p.id = es.paper_id
         LEFT JOIN users u        ON u.id = es.user_id
        WHERE es.team_id = ?
        ORDER BY es.started_at DESC
        LIMIT ? OFFSET ?`,
      [teamId, pageSize, offset],
    );
  }
}

export default ExamRepository;