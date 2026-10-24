/** A readable turn shared by the Codex and ChatGPT readers: the user's prompt and the
 * final reply text. Commentary, reasoning and tool items are left out. */
export interface TurnText { turnId: string; status: string; prompt: string | null; reply: string | null; truncated: boolean; error: string | null }
type Row = Record<string, any>;
const LIMIT = 20000;

export function turnText(turn: Row): TurnText {
  const items: Row[] = Array.isArray(turn?.items) ? turn.items : [];
  let truncated = false;
  const bound = (parts: string[]) => {
    const text = parts.filter(part => part.trim()).join('\n\n');
    if (!text) return null;
    if (text.length > LIMIT) truncated = true;
    return text.slice(0, LIMIT);
  };
  const prompt = bound(items.filter(item => item?.type === 'userMessage' && Array.isArray(item.content)).flatMap(item => item.content as Row[])
    .filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => { if (part.truncated) truncated = true; return part.text as string; }));
  const reply = bound(items.filter(item => item?.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string')
    .map(item => { if (item.truncated) truncated = true; return item.text as string; }));
  const error = turn?.error == null ? null : typeof turn.error === 'string' ? turn.error : typeof turn.error.message === 'string' ? turn.error.message : 'error';
  return { turnId: String(turn?.id ?? ''), status: String(turn?.status ?? ''), prompt, reply, truncated, error: error && error.slice(0, 2000) };
}
