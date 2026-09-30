import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, act } from '@testing-library/react';
import { attachmentOps, useAttachments, type PendingAttachment } from './AttachmentPicker';

const png = (name = 'shot.png') => new File(['png'], name, { type: 'image/png' });

/** A host whose attachments live in the component, the way the shell owns the composer's list. */
function controlledOps(): () => ReturnType<typeof attachmentOps> {
  let ops!: ReturnType<typeof attachmentOps>;
  function Controlled() {
    const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
    const [hint, setHint] = useState<string | null>(null);
    ops = attachmentOps({ attachments, setAttachments, hint, setHint });
    return null;
  }
  render(<Controlled />);
  return () => ops;
}

describe('attachmentOps', () => {
  it('revokes a pending preview when its attachment is removed', () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:shot'), revokeObjectURL: revoke });
    const ops = controlledOps();
    act(() => ops().addFiles([png()]));
    expect(ops().attachments).toHaveLength(1);
    act(() => ops().remove(ops().attachments[0]!));
    expect(revoke).toHaveBeenCalledWith('blob:shot');
    expect(ops().attachments).toEqual([]);
  });

  it('revokes every pending preview when the list is cleared, as a send does', () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn((file: File) => `blob:${file.name}`), revokeObjectURL: revoke });
    const ops = controlledOps();
    act(() => ops().addFiles([png('a.png'), png('b.png')]));
    expect(ops().attachments).toHaveLength(2);
    act(() => ops().clear());
    expect(revoke).toHaveBeenCalledWith('blob:a.png');
    expect(revoke).toHaveBeenCalledWith('blob:b.png');
    expect(ops().attachments).toEqual([]);
  });

  it('ignores adding and removing while disabled', () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:shot'), revokeObjectURL: revoke });
    let ops!: ReturnType<typeof attachmentOps>;
    function Disabled() {
      const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
      const [hint, setHint] = useState<string | null>(null);
      ops = attachmentOps({ attachments, setAttachments, hint, setHint }, true);
      return null;
    }
    render(<Disabled />);
    act(() => ops.addFiles([png()]));
    expect(ops.attachments).toEqual([]);
    act(() => ops.remove({ file: png(), url: 'blob:staged' }));
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe('useAttachments', () => {
  it('revokes whatever is still staged when its own list unmounts', () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:shot'), revokeObjectURL: revoke });
    let state!: ReturnType<typeof useAttachments>;
    function Local() { state = useAttachments(); return null; }
    const { unmount } = render(<Local />);
    act(() => state.addFiles([png()]));
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:shot');
  });
});
