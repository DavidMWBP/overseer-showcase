import { Mascot } from '@overseer/web';

// The card page is white; Overseer is dark-only, so every story sits on the app background.
const dark = (children: React.ReactNode) => <div style={{ background: "var(--bg)", color: "var(--text)", padding: 16, borderRadius: 6 }}>{children}</div>;

export const Idle = () => dark(<Mascot state="idle" />);
export const Thinking = () => dark(<Mascot state="thinking" />);
export const Working = () => dark(<Mascot state="working" energy="high" />);
export const Asking = () => dark(<Mascot state="asking" />);
export const LowEnergy = () => dark(<Mascot state="working" energy="low" />);
export const Sleeping = () => dark(<Mascot state="sleeping" />);
export const Offline = () => dark(<Mascot state="offline" />);
export const ErrorState = () => dark(<Mascot state="error" />);
