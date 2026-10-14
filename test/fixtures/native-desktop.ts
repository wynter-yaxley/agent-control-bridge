import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { BridgeConfig } from '../../src/config.ts';
import type { NativeChatPage } from '../../src/native-messages.ts';
import { WindowsNativeUi, type WindowsNativeTools } from '../../src/windows-native-host.ts';

/** Isolated stand-in for desktop app state that outlives a Bridge process.
 * Its UIA never exposes a conversation ID, matching the current ChatGPT build. */
interface DesktopState {
  projects: Awaited<ReturnType<WindowsNativeTools['listProjects']>>['projects'];
  threads: { id: string; kind: string; title: string; projectId?: string | null; cwd?: string }[];
  pages: Record<string, NativeChatPage>;
  creates: { workspace: number; gpt: number; codex: number };
  uiCalls: string[];
}
export function fileDesktop(statePath: string, config: BridgeConfig) {
  const load = (): DesktopState => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { projects: [], threads: [], pages: {}, creates: { workspace: 0, gpt: 0, codex: 0 }, uiCalls: [] };
  const update = (change: (state: DesktopState) => void) => { const state = load(); change(state); writeFileSync(statePath, JSON.stringify(state)); };
  const ui = new class extends WindowsNativeUi {
    override async call(operation: Parameters<WindowsNativeUi['call']>[0], fields: Parameters<WindowsNativeUi['call']>[1]) {
      update(state => {
        state.uiCalls.push(operation);
        if (operation === 'workspace-create') { state.creates.workspace++; state.projects.push({ projectId: `native-${randomUUID()}`, projectKind: 'local', hostId: 'local', label: fields.name, path: fields.path! }); }
        if (operation === 'gpt-create') {
          const id = randomUUID(); state.creates.gpt++; state.threads.push({ id, kind: 'chatgpt', title: fields.name });
          state.pages[id] = { thread: { id, kind: 'chatgpt', title: fields.name, status: { type: 'idle' } }, turns: [{ id: `turn-${id}`, status: 'completed', error: null, items: [{ type: 'userMessage', id: `user-${id}`, content: [{ type: 'text', text: fields.prompt! }] }] }] };
        }
      });
      return { ok: true, ordinaryModeObserved: operation === 'gpt-create', snapshot: { title: fields.name, text: '', ordinaryComposer: true, pid: 1, conversationId: null } };
    }
  }(config);
  const native: WindowsNativeTools = {
    listProjects: async () => ({ projects: load().projects }),
    listThreads: async () => ({ threads: load().threads, pinnedThreads: [] }),
    readThread: async id => load().pages[id],
    createCodexThread: async (projectId, name) => {
      const id = randomUUID();
      update(state => { state.creates.codex++; state.threads.push({ id, kind: 'codex', title: name, projectId, cwd: state.projects.find(item => item.projectId === projectId)!.path }); });
      return { threadId: id, projectId };
    },
  };
  return { ui, native, load, update };
}
