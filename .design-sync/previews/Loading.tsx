import { Loading } from '@overseer/web';

// The card page is white; Overseer is dark-only, so every story sits on the app background.
const dark = (children: React.ReactNode) => <div style={{ background: "var(--bg)", color: "var(--text)", padding: 16, borderRadius: 6 }}>{children}</div>;

const row = (title: string, meta: string) => (
  <div className="card" style={{ width: 220 }}>
    <div className="card-title">{title}</div>
    <div className="card-meta"><span className="chip">{meta}</span></div>
  </div>
);

export const Shimmering = () => dark(
  <Loading loading label="Loading the board…" placeholder={<div>{row('Placeholder bead title here', 'Ready')}{row('Another placeholder title', 'Running')}</div>}>
    <div />
  </Loading>
);

export const Arrived = () => dark(
  <Loading loading={false} placeholder={null}>
    <div>{row('Add day separators to the chat thread', 'Running')}{row('Cap vitest workers at four forks', 'Ready')}</div>
  </Loading>
);
