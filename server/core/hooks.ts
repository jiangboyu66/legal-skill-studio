import type { RunWarning, TranscriptEntry } from '../../shared/types';

/**
 * Hook system (cf. Claude Code hooks): code that runs at fixed points of the lifecycle.
 *  RunStart      – before any node runs (e.g. PII guard, audit)
 *  PreToolUse    – before a tool executes; may block it
 *  PostToolUse   – after a tool executes (audit, annotations)
 *  SkillOutput   – after a skill produced output (grounding checks, legal verification)
 *  ApprovalRequested / RunEnd – notifications and audit
 * Only built-in (reviewed) code hooks are allowed; plugins contribute declarative content, not code.
 */
export type HookEvent = 'RunStart' | 'PreToolUse' | 'PostToolUse' | 'SkillOutput' | 'ApprovalRequested' | 'RunEnd';

export interface HookOutcome {
  /** PreToolUse only: reason to block the tool call */
  block?: string;
  warnings?: RunWarning[];
  note?: string;
}

export interface Hook<C = unknown> {
  name: string;
  event: HookEvent;
  description: string;
  /** Optional matcher, e.g. a tool name for Pre/PostToolUse */
  matcher?: string;
  run(ctx: C): Promise<HookOutcome | void> | HookOutcome | void;
}

export class HookRunner {
  private hooks: Hook[] = [];

  register<C>(hook: Hook<C>) {
    this.hooks.push(hook as Hook);
    return this;
  }

  list() {
    return this.hooks.map((h) => ({ name: h.name, event: h.event, description: h.description }));
  }

  async run<C>(event: HookEvent, ctx: C, opts: { matcher?: string; onNote?: (e: TranscriptEntry) => void; turn?: number } = {}): Promise<HookOutcome> {
    const merged: HookOutcome = { warnings: [] };
    for (const h of this.hooks.filter((x) => x.event === event && (!x.matcher || x.matcher === opts.matcher))) {
      const r = (await h.run(ctx)) ?? {};
      if (r.warnings?.length) merged.warnings!.push(...r.warnings);
      if (r.note) opts.onNote?.({ type: 'hook', turn: opts.turn ?? 0, hook: h.name, message: r.note });
      if (r.block && !merged.block) merged.block = `${h.name}: ${r.block}`;
    }
    return merged;
  }
}
