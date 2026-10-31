import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ErrorNotice, fmtTime, LifecycleBadge, Loading, useAuth, useLoad, useToast } from '../components/ui';

export default function SkillsList() {
  const { can } = useAuth();
  const consumer = !can('skill.edit') && !can('skill.approve');
  const { data: skills, error: loadError } = useLoad(() => api.skills.list(), []);
  const [error, setError] = useState<unknown>();
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const nav = useNavigate();

  async function onImport(file?: File) {
    if (!file) return;
    try {
      const r = await api.skills.importMd(await file.text());
      toast(`已导入 Skill「${r.skill.name}」（草稿）${r.warnings.length ? `：${r.warnings.join('；')}` : ''}`);
      nav(`/skills/${r.skill.id}`);
    } catch (e) {
      setError(e);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Skills</h1>
          {consumer ? (
            <p>Skill 是工作流中的一个 AI 步骤。这里列出已发布的 Skill，点开可以查看它做什么、需要什么输入、输出什么；使用时请到“工作流”中运行。</p>
          ) : (
            <p>
              Skill 是一项可重复使用的 AI 任务：写清楚任务说明，关联经审核的规则包，定义输入、输出和可用工具，用样例测试后提交审核。AI 以“代理”方式执行：可以按需查阅文档和规则，最后提交结构化结果并接受自动核对。
            </p>
          )}
        </div>
        <div className="actions">
          {can('skill.edit') && (
            <>
              <input ref={fileRef} type="file" accept=".md,text/markdown" hidden onChange={(e) => onImport(e.target.files?.[0])} data-testid="import-file" />
              <button onClick={() => fileRef.current?.click()} title="导入 Agent Skills 标准格式的 SKILL.md">
                导入 SKILL.md
              </button>
              <Link className="btn primary" to="/skills/new" data-testid="new-skill">
                新建 Skill
              </Link>
            </>
          )}
        </div>
      </div>
      <ErrorNotice error={loadError ?? error} />
      {!skills && !loadError && <Loading />}
      {skills && (
        <div className="list" data-testid="skills-list">
          {skills.length === 0 && <div className="empty">{consumer ? '还没有已发布的 Skill。' : '还没有 Skill。'}</div>}
          {skills.map((s) => {
            const c = s.published ?? s.draft;
            return (
              <div className="item" key={s.id}>
                <div>
                  <h3>
                    <Link to={`/skills/${s.id}`}>{s.name}</Link>
                  </h3>
                  <p>{s.description || <span className="muted">（无描述）</span>}</p>
                  <div className="row wrap">
                    <LifecycleBadge status={s.status} version={s.publishedVersion} dirty={s.dirty} />
                    {s.category && <span className="badge">{s.category}</span>}
                    {s.jurisdiction && <span className="badge">法域 {s.jurisdiction}</span>}
                    <span className="badge">{c.output.format === 'json' ? '结构化输出' : 'Markdown 输出'}</span>
                    {c.rulePackIds.length > 0 && <span className="badge">{c.rulePackIds.length} 个规则包</span>}
                    {c.verification?.enabled && <span className="badge ok">结论核验</span>}
                    {c.inputs.some((i) => i.type === 'document') && <span className="badge">支持 PDF/Word/图片</span>}
                    <span className="small muted">
                      {consumer ? '' : `更新于 ${fmtTime(s.updatedAt)} · `}
                      {s.usedBy.length ? `被 ${s.usedBy.length} 个工作流使用` : '未被工作流使用'}
                    </span>
                  </div>
                </div>
                <div className="actions">
                  <Link className="btn sm" to={`/skills/${s.id}`}>
                    {can('skill.edit') ? '编辑与测试' : consumer ? '查看说明' : '查看'}
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
