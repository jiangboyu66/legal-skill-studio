import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { ChatAttachment, ChatSendResult, Conversation, ConversationMessage, Org, User } from '../../shared/types';
import { answerFollowUp, DEFAULT_TITLE, historyFor, inputsFromChat, summarize, targetRunId, titleFrom } from '../core/chat';
import { requirePermission } from '../core/permissions';
import type { AppContext } from '../context';
import { AppError, Errors } from '../errors';
import { can, h, param, text, who } from './util';
import { runForViewer } from './views';

const now = () => new Date().toISOString();
const mid = () => `msg_${randomUUID().slice(0, 10)}`;
const MAX_MESSAGES = 400;
const TERMINAL = ['succeeded', 'failed', 'rejected'];

/**
 * Chat home API. Conversations are private to their creator. A "run" message starts an ordinary workflow
 * run (same permissions and checks as the run page); an "ask" message answers a follow-up question from
 * one of the conversation's runs.
 */
export function conversationsRouter(ctx: AppContext) {
  const r = Router();
  const { db, engine } = ctx;
  /** One follow-up at a time per conversation (the answer is appended to the thread when it arrives). */
  const answering = new Set<string>();

  const own = (org: Org, user: User, id: string): Conversation => {
    const c = db.conversations.get(org.id, id);
    if (!c || c.userId !== user.id) throw Errors.notFound('对话');
    return c;
  };
  const save = (c: Conversation) => {
    if (c.messages.length > MAX_MESSAGES) c.messages = c.messages.slice(-MAX_MESSAGES);
    c.updatedAt = now();
    return db.conversations.put(c);
  };

  r.get(
    '/',
    h((req) => {
      const { user, org } = who(req);
      return db.listConversations(org.id, user.id).map(summarize);
    }),
  );

  r.post(
    '/',
    h((req, res) => {
      const { user, org } = who(req);
      const b = (req.body ?? {}) as { title?: unknown; workflowId?: unknown };
      const t = now();
      const c: Conversation = { id: `conv_${randomUUID().slice(0, 8)}`, orgId: org.id, userId: user.id, title: text(b.title, 80) || DEFAULT_TITLE, workflowId: text(b.workflowId, 60) || undefined, messages: [], createdAt: t, updatedAt: t };
      db.conversations.put(c);
      res.status(201);
      return c;
    }),
  );

  r.get(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      return own(org, user, param(req, 'id'));
    }),
  );

  r.patch(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      const c = own(org, user, param(req, 'id'));
      const b = (req.body ?? {}) as { title?: unknown; workflowId?: unknown };
      const title = text(b.title, 80);
      if (b.title !== undefined && !title) throw Errors.badRequest('标题不能为空。');
      if (title) c.title = title;
      if (typeof b.workflowId === 'string') c.workflowId = text(b.workflowId, 60) || undefined;
      return save(c);
    }),
  );

  r.delete(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      const c = own(org, user, param(req, 'id'));
      db.conversations.delete(org.id, c.id);
      ctx.rt.audit(org.id, user, 'conversation.delete', 'conversation', c.id, { runs: summarize(c).runIds });
      return { ok: true };
    }),
  );

  r.post(
    '/:id/messages',
    h(async (req, res): Promise<ChatSendResult> => {
      const { user, org } = who(req);
      const c = own(org, user, param(req, 'id'));
      const b = (req.body ?? {}) as { mode?: unknown; text?: unknown; workflowId?: unknown; attachments?: unknown; inputs?: unknown; runId?: unknown; rerunOf?: unknown };
      const msgText = text(b.text, 200_000);

      // ── follow-up question about a run in this conversation ──
      if (b.mode === 'ask') {
        requirePermission(user, org, 'workflow.run');
        if (!msgText) throw Errors.badRequest('请输入要追问的问题。');
        if (msgText.length > 4000) throw Errors.badRequest('追问内容过长（上限 4000 字）。', '请把问题拆短；新的材料请用“审阅新材料”发送。');
        const runId = targetRunId(c, text(b.runId, 40) || undefined);
        if (!runId) throw Errors.badRequest('这个对话里还没有运行结果可以追问。', '先发送材料并完成一次审阅。');
        const run = engine.get(org.id, runId);
        if (!TERMINAL.includes(run.status)) throw new AppError('RUN_NOT_FINISHED', '这次运行还没有结束，结束后再追问。', { status: 409, hint: '运行卡片会实时显示进度；需要审批的节点需先由审核人处理。' });
        if (answering.has(c.id)) throw new AppError('CHAT_BUSY', '上一条追问还在回答中，请稍候。', { status: 409 });
        answering.add(c.id);
        try {
          const history = historyFor(c, runId);
          c.messages.push({ id: mid(), role: 'user', at: now(), mode: 'ask', text: msgText, runId });
          if (c.title === DEFAULT_TITLE) c.title = titleFrom(msgText, []);
          save(c);
          ctx.rt.audit(org.id, user, 'conversation.ask', 'run', runId, { conversationId: c.id });
          const exec = await answerFollowUp({ rt: ctx.rt, org, user, run, question: msgText, history });
          // Re-read: the thread may have been renamed meanwhile; append to the stored copy.
          const fresh = db.conversations.get(org.id, c.id) ?? c;
          const reply: ConversationMessage =
            exec.ok && typeof exec.output === 'string' && exec.output.trim()
              ? { id: mid(), role: 'assistant', at: now(), kind: 'answer', text: exec.output, runId, provider: ctx.rt.provider.info, usage: exec.usage, security: exec.security, latencyMs: exec.latencyMs }
              : { id: mid(), role: 'assistant', at: now(), kind: 'error', text: exec.error?.message ?? '没有得到回答。', code: exec.error?.code, hint: exec.error?.hint, runId };
          fresh.messages.push(reply);
          return { conversation: save(fresh) };
        } finally {
          answering.delete(c.id);
        }
      }

      // ── review new material: start a workflow run ──
      requirePermission(user, org, 'workflow.run');
      let workflowId = text(b.workflowId, 60) || c.workflowId || '';
      let inputs: Record<string, unknown> | undefined;
      const attachments: ChatAttachment[] = [];
      let rerunOf: string | undefined;
      const prevId = text(b.rerunOf, 40);
      if (prevId) {
        // "重新运行" from a run card: same workflow and inputs as that run.
        if (!targetRunId(c, prevId)) throw Errors.notFound('对话中的运行');
        const prev = engine.get(org.id, prevId);
        workflowId = prev.workflowId;
        inputs = {};
        for (const [k, v] of Object.entries(prev.inputs)) inputs[k] = prev.documents[k] ? { documentId: prev.documents[k] } : v;
        rerunOf = prev.id;
      } else {
        const raw = Array.isArray(b.attachments) ? b.attachments.slice(0, 5) : [];
        for (const a of raw) {
          const id = text((a as { documentId?: unknown })?.documentId, 60);
          const doc = id ? db.documents.get(org.id, id) : undefined;
          if (!doc) throw Errors.badRequest('附件不存在或已被删除。', '请重新上传文件。');
          attachments.push({ documentId: doc.id, filename: doc.filename, kind: doc.kind, pageCount: doc.pages.length });
        }
        if (!msgText && !attachments.length) throw Errors.badRequest('请上传材料文件，或直接粘贴材料文字。');
      }
      if (!workflowId) throw Errors.badRequest('请选择要使用的工作流。');
      const wf = db.workflows.get(org.id, workflowId);
      if (!wf) throw Errors.notFound('工作流');
      if (!wf.published) throw new AppError('WORKFLOW_NOT_PUBLISHED', `工作流「${wf.name}」尚未发布，不能在对话中运行。`, { status: 409, hint: '对话只运行已发布的工作流；草稿请在工作流页面“测试运行”。' });
      const params = b.inputs && typeof b.inputs === 'object' && !Array.isArray(b.inputs) ? (b.inputs as Record<string, unknown>) : {};
      inputs ??= inputsFromChat(wf.published.inputs, { text: msgText, attachments, params });
      // Validation errors (missing inputs, unapproved rule packs …) are returned to the composer, not stored.
      const run = await engine.start({ org, user, workflow: wf, mode: 'production', inputs, rerunOf });
      const t = now();
      const shownText = rerunOf ? `重新运行 ${rerunOf}` : msgText;
      c.messages.push({ id: mid(), role: 'user', at: t, mode: 'run', text: shownText, attachments: attachments.length ? attachments : undefined, workflowId: wf.id, workflowName: wf.name });
      c.messages.push({ id: mid(), role: 'assistant', at: t, kind: 'run', runId: run.id, workflowId: wf.id, workflowName: wf.name });
      c.workflowId = wf.id;
      if (c.title === DEFAULT_TITLE) c.title = titleFrom(rerunOf ? wf.name : msgText, attachments);
      res.status(201);
      return { conversation: save(c), run: runForViewer(run, can(user, org, 'run.view_internals')) };
    }),
  );

  return r;
}
