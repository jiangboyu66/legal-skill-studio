import { createContext, useContext } from 'react';
import type { ConversationSummary } from '../../shared/types';

/** Small per-browser preferences (localStorage; failures fall back to defaults). */
const THINKING_KEY = 'lss.thinking';
const WF_KEY = 'lss.chat.workflow';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** "深度思考" (print the model's reasoning) — remembered between runs. */
export const readThinkingPref = () => read(THINKING_KEY) === '1';
export const writeThinkingPref = (on: boolean) => write(THINKING_KEY, on ? '1' : '0');

/** Workflow last used in the chat. */
export const readWorkflowPref = () => read(WF_KEY) ?? '';
export const writeWorkflowPref = (id: string) => write(WF_KEY, id);

/** The user's conversations, shown in the main sidebar; pages call reload() after changing them. */
export interface ConversationsState {
  items?: ConversationSummary[];
  reload: () => void;
}
export const ConversationsCtx = createContext<ConversationsState>({ reload: () => undefined });
export const useConversations = () => useContext(ConversationsCtx);
