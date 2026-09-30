import { Rail } from '@overseer/web';

const repo = (id: string, path: string) => ({
  id, path, base_branch: 'main', verify_command: 'pnpm test', setup_command: 'pnpm install', merge_mode: 'local-merge' as const,
  batch_approver: 'user' as const, worker_limit: 3, review_rounds: 2,
});
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const noop = () => {};
const shell = (children: React.ReactNode) => <div style={{ width: 232, height: 800, display: 'grid' }}>{children}</div>;

export const Working = () => shell(
  <Rail
    view="office"
    repos={[repo('overseer', 'E:/Projects/Overseer'), repo('site', 'E:/Projects/site')]}
    costs={{ repos: [{ repo_id: 'overseer', total: 48.21, today: 3.4, unknown: 0 }, { repo_id: 'site', total: 6.5, today: 0, unknown: 2 }], batches: [] }}
    status={{ bd_ok: true, orchestrator: { status: 'running', native_session_id: 'n-1', last_activity_at: ago(1), busy: true, model: 'opus', context: { tokens: 84_000, window: 200_000 } } }}
    daemon={{ pid: 4120, started_at: ago(300), commit: 'd298e00', source_head: 'd298e00', restart_needed: false }}
    counts={{ running: 3, questions: 1, failed: 1, review: 1 }}
    activity={{ state: 'tool', tool: 'spawn_worker', summary: 'Dispatching overseer-4fq', started_at: ago(0.7) }}
    setupAlert={false} onView={noop} onRepo={noop} onNewSession={noop}
  />,
);

export const RestartNeeded = () => shell(
  <Rail
    view="office"
    repos={[repo('overseer', 'E:/Projects/Overseer')]}
    costs={{ repos: [{ repo_id: 'overseer', total: 48.21, today: 0, unknown: 0 }], batches: [] }}
    status={{ bd_ok: true, orchestrator: { status: 'ended', native_session_id: null, last_activity_at: ago(95), busy: false, model: 'opus', context: null } }}
    daemon={{ pid: 4120, started_at: ago(2000), commit: '09d1e87', source_head: 'd298e00', restart_needed: true }}
    counts={{ running: 0, questions: 0, failed: 0, review: 1 }}
    setupAlert onView={noop} onRepo={noop} onNewSession={noop}
  />,
);

export const Offline = () => shell(
  <Rail
    view="chat" offline
    repos={[repo('overseer', 'E:/Projects/Overseer')]}
    costs={null} status={null} daemon={null}
    counts={{ running: 0, questions: 0, failed: 0, review: 0 }}
    loadFailed={() => true}
    setupAlert={false} onView={noop} onRepo={noop} onNewSession={noop}
  />,
);
