import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Rule, RulePackContent, SkillConfig, WorkflowDef } from '../../shared/types';
import { api } from '../api';
import DagGraph from '../components/DagGraph';
import { Diff } from '../components/Diff';
import { EvalCompare } from '../components/EvalPanel';
import { ErrorNotice, fmtTime, Loading, useAuth, useLoad, useToast } from '../components/ui';

const TYPE: Record<string, string> = { skill: 'Skill', workflow: '工作流', rulepack: '规则包' };
const VERIF: Record<string, [string, string]> = { verbatim: ['原文已核对', 'ok'], paraphrased: ['转述', 'warn'], unverified: ['未核实', 'bad'] };

function RulesReview({ rules, current }: { rules: Rule[]; current?: RulePackContent }) {
  const prev = new Map((current?.rules ?? []).map((r) => [r.id, JSON.stringify(r)]));
  return (
    <table className="t rules-review" data-testid="rules-review">
      <thead>
        <tr>
          <th>编号</th>
          <th>规则</th>
          <th>来源</th>
          <th>核实程度</th>
          <th>适用渠道</th>
        </tr>
      </thead>
      <tbody>
        {rules.map((r) => {
          const change = !current ? '' : !prev.has(r.id) ? '新增' : prev.get(r.id) !== JSON.stringify(r) ? '修改' : '';
          return (
            <tr key={r.id} className={`v-${r.source.verification}`}>
              <td className="mono">
                {r.id}
                {change && <div className="badge warn">{change}</div>}
              </td>
              <td>
                <strong>{r.title}</strong>（{r.severity}）<div className="small">{r.text}</div>
              </td>
              <td className="small">
                {r.source.url ? (
                  <a href={r.source.url} target="_blank" rel="noreferrer">
                    {r.source.title}
                  </a>
                ) : (
                  r.source.title
                )}
                {r.source.excerpt && <div className="quote small">“{r.source.excerpt}”</div>}
              </td>
              <td>
                <span className={`badge ${VERIF[r.source.verification][1]}`}>{VERIF[r.source.verification][0]}</span>
              </td>
              <td className="small">{r.appliesTo?.channels?.join(', ') ?? '全部'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const inSixMonths = () => new Date(Date.now() + 182 * 86400_000).toISOString().slice(0, 10);

export default function ReviewDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { me } = useAuth();
  const { data, error, reload } = useLoad(() => api.reviews.get(id!), [id]);
  const [comment, setComment] = useState('');
  const [name, setName] = useState(me.user.name);
  const [qual, setQual] = useState('');
  const [attested, setAttested] = useState(false);
  const [due, setDue] = useState(inSixMonths());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();

  if (error) return <ErrorNotice error={error} />;
  if (!data) return <Loading />;
  const r = data.request;
  const type = r.entityType;
  const editorUrl = `/${type === 'rulepack' ? 'rulepacks' : `${type}s`}/${r.entityId}`;

  async function decide(decision: 'approved' | 'rejected') {
    setBusy(true);
    setActionError(undefined);
    try {
      await api.reviews.decide(r.id, { decision, comment, attestation: type === 'rulepack' && decision === 'approved' ? { approverName: name, approverQualification: qual, attested, reviewDueAt: due } : undefined });
      toast(decision === 'approved' ? (type === 'rulepack' ? '已批准规则包并记录审核声明' : '已批准并发布新版本') : '已驳回');
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }
  async function withdraw() {
    try {
      await api.reviews.withdraw(r.id);
      toast('已撤回申请');
      nav(editorUrl);
    } catch (e) {
      setActionError(e);
    }
  }

  const snap = r.snapshot;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {TYPE[type]}审核：{data.entity.name}
          </h1>
          <div className="row wrap small">
            <span className={`badge ${r.status === 'pending' ? 'warn' : r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'bad' : ''}`} data-testid="review-status">
              {{ pending: '待审核', approved: '已批准', rejected: '已驳回', withdrawn: '已撤回' }[r.status]}
            </span>
            <span className="muted">
              {r.submittedByName} 于 {fmtTime(r.createdAt)} 提交{data.currentVersion ? `（线上版本 v${data.currentVersion}）` : '（首次发布）'}
            </span>
            <Link to={editorUrl}>打开{TYPE[type]}</Link>
          </div>
          {r.note && <p className="small" style={{ marginTop: 6 }}>提交说明：{r.note}</p>}
          {r.decidedByName && (
            <p className="small">
              {r.decidedByName} 于 {fmtTime(r.decidedAt)} 处理{r.comment ? `：${r.comment}` : ''}
            </p>
          )}
        </div>
      </div>

        <div className="grid-2 review-top">
          {r.status === 'pending' && (
            <section className="panel" data-testid="decision-panel">
              <h2 className="section">审核决定</h2>
              {r.canDecide ? (
                <>
                  {type === 'rulepack' && (
                    <div className="attest-form">
                      <p className="section-help">批准规则包需要签署审核声明。声明会随版本永久保存，并显示在每次使用该版本的运行记录和报告中。</p>
                      <label className="field">
                        <span className="lbl">审核人姓名</span>
                        <input type="text" value={name} onChange={(e) => setName(e.target.value)} data-testid="attest-name" />
                      </label>
                      <label className="field">
                        <span className="lbl">执业资格</span>
                        <input type="text" value={qual} onChange={(e) => setQual(e.target.value)} placeholder="如：新加坡执业律师" aria-describedby="attest-qual-help" data-testid="attest-qualification" />
                        <div className="field-help" id="attest-qual-help">
                          写明执业地区、资格名称（如 Advocate &amp; Solicitor）和执业证号，便于日后核验。
                        </div>
                      </label>
                      <label className="field">
                        <span className="lbl">复审截止日期</span>
                        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} data-testid="attest-due" />
                      </label>
                      <label className="check" style={{ whiteSpace: 'normal', alignItems: 'flex-start' }}>
                        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} data-testid="attest-check" />
                        本人已逐条核对规则内容、来源及适用范围，确认可用于本组织的营销物料初审。
                      </label>
                    </div>
                  )}
                  <label className="field" style={{ marginTop: 10 }}>
                    <span className="lbl">审核意见（驳回时必填）</span>
                    <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="review-comment" />
                  </label>
                  <div className="row">
                    <button className="primary" onClick={() => decide('approved')} disabled={busy || (type === 'rulepack' && (!attested || !qual.trim() || !name.trim()))} data-testid="approve-review">
                      {type === 'rulepack' ? '签署并批准' : '批准并发布'}
                    </button>
                    <button className="danger" onClick={() => decide('rejected')} disabled={busy || !comment.trim()} data-testid="reject-review">
                      驳回
                    </button>
                  </div>
                </>
              ) : (
                <div className="notice info small">{r.blockedReason ?? '你没有审核此类申请的权限。'}</div>
              )}
              {r.canWithdraw && (
                <button className="sm" style={{ marginTop: 12 }} onClick={withdraw} data-testid="withdraw-review">
                  撤回申请（解锁草稿以便修改）
                </button>
              )}
              <ErrorNotice error={actionError} />
            </section>
          )}
          <section className="panel small">
            <h2 className="section">审核要点</h2>
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {type === 'rulepack' ? (
                <>
                  <li>规则内容是否与来源一致，转述是否改变了含义；</li>
                  <li>适用渠道和默认风险等级是否合理；</li>
                  <li>是否遗漏本组织必须遵守的要求；</li>
                  <li>示例规则包整理自公开资料，平台演示账号的批准不等于执业律师审核。</li>
                </>
              ) : (
                <>
                  <li>任务说明是否清楚、是否要求 AI 引用原文和规则编号；</li>
                  <li>是否关联了正确的、已批准的规则包；</li>
                  <li>输出结构、引文核对和结论核验是否覆盖关键风险；</li>
                  <li>{type === 'skill' ? '对比评测：留出集指标是否下降、是否出现“不应标记”误报；' : '钉住的 Skill 版本是否是你审阅过的版本；'}</li>
                  <li>建议先在“测试运行”中用样例验证。</li>
                </>
              )}
            </ul>
            {me.user.id === r.submittedBy && <p className="muted">你是本申请的提交人。</p>}
          </section>
        </div>
            <div className="stack" style={{ marginTop: 16 }}>
          {type === 'skill' && (
            <>
              <section className="panel" data-testid="review-evals">
                <h2 className="section">评测对比（留出集）</h2>
                <p className="section-help">提交的配置与线上版本在同一评测集上的表现。指标只说明在标注样例上的差异，不能代替逐条审阅；没有评测时可要求提交人先运行评测。</p>
                <EvalCompare a={data.evals?.submitted} b={data.evals?.published} labelA="本次提交" labelB={data.currentVersion ? `线上 v${data.currentVersion}` : '线上版本'} />
              </section>
              <section className="panel">
                <h2 className="section">任务说明（与线上版本对比）</h2>
                <Diff before={(data.current as SkillConfig | undefined)?.instructions} after={(snap as SkillConfig).instructions} />
              </section>
              <section className="panel">
                <h2 className="section">完整配置（与线上版本对比）</h2>
                <Diff before={data.current ? JSON.stringify({ ...(data.current as SkillConfig), instructions: undefined }, null, 2) : undefined} after={JSON.stringify({ ...(snap as SkillConfig), instructions: undefined }, null, 2)} />
              </section>
            </>
          )}
          {type === 'workflow' && (
            <>
              <section className="panel">
                <h2 className="section">提交的流程</h2>
                <DagGraph nodes={(snap as WorkflowDef).nodes} />
              </section>
              <section className="panel" data-testid="review-pins">
                <h2 className="section">将钉住的 Skill 版本</h2>
                <p className="section-help">批准后，正式运行只使用这里列出的 Skill 版本；之后发布的新版本不会自动生效，需要再次提交本工作流审批。</p>
                <table className="t pin-table">
                  <thead>
                    <tr>
                      <th>Skill</th>
                      <th>本次钉住</th>
                      <th>线上工作流当前钉住</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries((snap as WorkflowDef).pins ?? {}).map(([sid, v]) => (
                      <tr key={sid}>
                        <td>{(snap as WorkflowDef).nodes.find((n) => n.type === 'skill' && n.skillId === sid)?.name ?? sid}</td>
                        <td>v{v}</td>
                        <td>{(data.current as WorkflowDef | undefined)?.pins?.[sid] ? `v${(data.current as WorkflowDef).pins![sid]}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="panel">
                <h2 className="section">定义（与线上版本对比）</h2>
                <Diff before={data.current ? JSON.stringify(data.current, null, 2) : undefined} after={JSON.stringify(snap, null, 2)} />
              </section>
            </>
          )}
          {type === 'rulepack' && (
            <section className="panel">
              <h2 className="section">规则逐条核对（{(snap as RulePackContent).rules.length} 条）</h2>
              <p className="section-help">
                请逐条核对：规则是否准确反映来源原文、适用范围是否正确、是否适合本组织的业务。“转述”和“未核实”的规则需对照原始法规或准则确认。
                {data.stats && ` 本次：原文已核对 ${data.stats.verbatim}，转述 ${data.stats.paraphrased}，未核实 ${data.stats.unverified}。`}
              </p>
              <RulesReview rules={(snap as RulePackContent).rules} current={data.current as RulePackContent | undefined} />
            </section>
          )}
        </div>

    </>
  );
}
