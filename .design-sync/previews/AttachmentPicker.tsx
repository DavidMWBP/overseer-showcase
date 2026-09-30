import { useEffect } from 'react';
import { AttachmentPicker, useAttachments } from '@overseer/web';

// A small solid-colour PNG drawn on a canvas, standing in for a pasted screenshot.
function swatch(name: string, color: string): Promise<File> {
  const c = document.createElement('canvas');
  c.width = 96; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = color; g.fillRect(0, 0, 96, 64);
  g.fillStyle = '#e7ebf0'; g.fillRect(10, 10, 50, 6); g.fillRect(10, 24, 70, 6);
  return new Promise((resolve) => c.toBlob((b) => resolve(new File([b!], name, { type: 'image/png' })), 'image/png'));
}

const composer = (children: React.ReactNode) => <div style={{ background: 'var(--bg)', padding: 16, borderRadius: 6 }}><div className="composer" style={{ maxWidth: 420 }}><div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div></div></div>;

export const TwoImagesStaged = () => {
  const state = useAttachments();
  useEffect(() => { void Promise.all([swatch('board.png', '#1c2430'), swatch('review.png', '#3fb1a3')]).then((f) => state.addFiles(f)); }, []);
  return composer(<AttachmentPicker state={state} showHint />);
};

export const RejectedFile = () => {
  const state = useAttachments();
  useEffect(() => { state.addFiles([new File(['%PDF'], 'spec.pdf', { type: 'application/pdf' })]); }, []);
  return composer(<AttachmentPicker state={state} showHint />);
};

export const Disabled = () => {
  const state = useAttachments(true);
  return composer(<AttachmentPicker state={state} disabled />);
};
