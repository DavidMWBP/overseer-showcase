import { useEffect, useRef, useState, type ClipboardEvent, type Dispatch, type DragEvent, type SetStateAction } from 'react';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export type PendingAttachment = { file: File; url: string };
/** The list and its hint line, owned by whoever must outlive the picker: the shell for the composer, the pane for a rejection note. */
export type AttachmentHost = {
  attachments: PendingAttachment[];
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  hint: string | null;
  setHint: Dispatch<SetStateAction<string | null>>;
};

export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.readAsDataURL(file);
  });
}

/**
 * The attachment operations over a host the caller owns. A preview URL is revoked when its attachment is removed or the
 * list is cleared (a send), never when the picker unmounts: Chat's host lives in the shell, so navigating away and back
 * keeps the staged previews alive.
 */
export function attachmentOps(host: AttachmentHost, disabled = false, onFirstAdd?: () => void) {
  const { attachments, setAttachments, hint, setHint } = host;
  const addFiles = (files: Iterable<File>) => {
    if (disabled) return;
    const next: PendingAttachment[] = []; let message: string | null = null; let count = attachments.length;
    for (const file of files) {
      if (!IMAGE_MIMES.has(file.type)) { message ??= `${file.name} is not a supported image`; continue; }
      if (file.size > MAX_ATTACHMENT_BYTES) { message ??= `${file.name} exceeds 8 MB`; continue; }
      if (count >= MAX_ATTACHMENTS) { message ??= `At most ${MAX_ATTACHMENTS} images can be attached`; continue; }
      next.push({ file, url: URL.createObjectURL(file) }); count++;
    }
    if (next.length) {
      if (attachments.length === 0) onFirstAdd?.();
      setAttachments((old) => [...old, ...next]);
    }
    setHint(message);
  };
  const remove = (attachment: PendingAttachment) => { if (!disabled) { URL.revokeObjectURL(attachment.url); setAttachments((old) => old.filter((a) => a !== attachment)); setHint(null); } };
  const clear = (sent = attachments) => { setAttachments((old) => {
    const sentSet = new Set(sent);
    old.filter((a) => sentSet.has(a)).forEach((a) => URL.revokeObjectURL(a.url));
    return old.filter((a) => !sentSet.has(a));
  }); setHint(null); };
  // Spread onto the element images may be dropped on (the Chat composer, the rejection note); `drop-active` is the cue that it is a target.
  const dropProps = {
    onDragOver: (e: DragEvent<HTMLElement>) => { if (!disabled && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.currentTarget.classList.add('drop-active'); } },
    onDragLeave: (e: DragEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) e.currentTarget.classList.remove('drop-active'); },
    onDrop: (e: DragEvent<HTMLElement>) => { e.preventDefault(); e.currentTarget.classList.remove('drop-active'); addFiles(e.dataTransfer.files); },
  };
  // Spread onto the textarea: a pasted image is attached, anything else pasted stays the textarea's to handle (no hint for a pasted file that is not an image).
  const pasteProps = {
    onPaste: (e: ClipboardEvent<HTMLElement>) => {
      const files = [...e.clipboardData.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => f !== null);
      if (files.length) addFiles(files);
    },
  };
  /** The `attachments` of a POST body: raw base64 per pending file, in the order they were added. */
  const toBody = () => Promise.all(attachments.map(async ({ file }) => ({ name: file.name, mime: file.type, data: await readBase64(file) })));
  return { attachments, hint, setHint, addFiles, remove, clear, dropProps, pasteProps, toBody };
}

/** The picker's own list, for a pane that unmounts with its staged previews (the review rejection note). */
export function useAttachments(disabled = false) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const current = useRef<PendingAttachment[]>([]);
  useEffect(() => { current.current = attachments; }, [attachments]);
  useEffect(() => () => { current.current.forEach((a) => URL.revokeObjectURL(a.url)); }, []);
  return attachmentOps({ attachments, setAttachments, hint, setHint }, disabled);
}

export function AttachmentPreviews(p: { state: ReturnType<typeof attachmentOps>; disabled?: boolean }) {
  const { attachments, remove } = p.state;
  return attachments.length > 0 && <div className="attachments-pending">{attachments.map((a) => <div className="attachment-pending" key={a.url}><img src={a.url} alt={a.file.name} /><button type="button" aria-label={`Remove ${a.file.name}`} title={`Remove ${a.file.name}`} disabled={p.disabled} onClick={() => remove(a)}>×</button></div>)}</div>;
}

export function AttachmentButton(p: { state: ReturnType<typeof useAttachments>; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const { addFiles } = p.state;
  return <>
    <input ref={input} className="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={p.disabled} onChange={(e) => { addFiles(e.target.files ?? []); e.currentTarget.value = ''; }} />
    <button type="button" className="attach-image" aria-label="Attach image" title="Attach image" disabled={p.disabled} onClick={() => input.current?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20.5 11.5-8.7 8.7a6 6 0 0 1-8.5-8.5L12 3a4 4 0 0 1 5.7 5.7L9.3 17a2 2 0 0 1-2.8-2.8l7.8-7.8" /></svg></button>
  </>;
}

export function AttachmentPicker(p: { state: ReturnType<typeof useAttachments>; disabled?: boolean; showHint?: boolean }) {
  return <><AttachmentPreviews state={p.state} disabled={p.disabled} /><AttachmentButton state={p.state} disabled={p.disabled} />{p.showHint && p.state.hint && <span className="composer-hint composer-hint-error" role="alert">{p.state.hint}</span>}</>;
}
