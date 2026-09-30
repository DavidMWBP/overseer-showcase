import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config';

export type AttachmentInput = { name: string; mime: string; data: Buffer };
export type StoredAttachment = { name: string; mime: string; size: number; path: string };

const ATTACHMENT_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Writes each attached file under `<orchestratorDir>/attachments/<storageKey>-<index>.<ext>`. */
export function storeAttachments(config: Config, storageKey: string | number, attachments: AttachmentInput[]): StoredAttachment[] {
  const dir = path.resolve(config.orchestratorDir, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  return attachments.map((a, i) => {
    const file = path.join(dir, `${storageKey}-${i}.${ATTACHMENT_EXT[a.mime]}`);
    fs.writeFileSync(file, a.data);
    return { name: a.name, mime: a.mime, size: a.data.length, path: file };
  });
}
