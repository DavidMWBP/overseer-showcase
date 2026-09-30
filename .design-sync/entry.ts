// design-sync entry: the prop-driven components of packages/web, bundled for Claude Design.
// The web package has no library build, and the converter's synth-from-src/ mode would pull in main.tsx
// (which mounts the whole app), so this barrel names the exported set explicitly.
import './fonts.css';
import '../packages/web/src/styles.css';

export { Activity } from '../packages/web/src/components/Activity';
export { AttachmentPicker, AttachmentButton, AttachmentPreviews, useAttachments } from '../packages/web/src/components/AttachmentPicker';
export { BatchRow } from '../packages/web/src/components/BatchRow';
export { Card } from '../packages/web/src/components/Card';
export { Diff } from '../packages/web/src/components/Diff';
export { Loading } from '../packages/web/src/components/Loading';
export { Mascot } from '../packages/web/src/components/Mascot';
export { PlainText } from '../packages/web/src/components/PlainText';
export { Rail } from '../packages/web/src/components/Rail';
export { Toasts } from '../packages/web/src/components/Toasts';
export { UsageChart } from '../packages/web/src/components/UsageChart';
// Toasts renders a module-level store; pushToast is how a design shows one.
export { pushToast, dismissToast } from '../packages/web/src/lib/toasts';
