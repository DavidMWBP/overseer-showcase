import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { BatchDetail } from '@overseer/shared';
import { BatchReviewBlock } from './BatchReviewBlock';
import { board, batchDetail } from '../test/fixtures';

const noop = () => {};

function renderBlock(mergeMode: 'local-merge' | 'gitlab-mr', mrUrl: string | null) {
  const id = `review-block-${mergeMode}-${mrUrl ? 'with-mr' : 'without-mr'}`;
  const detail: BatchDetail = {
    ...batchDetail,
    batch: { ...batchDetail.batch, id, status: 'review', mr_url: mrUrl },
    repo: { ...batchDetail.repo, merge_mode: mergeMode },
  };
  const batches = [{ ...board.repos[0]!.batches[0]!, id, status: 'review' as const, mr_url: mrUrl }];
  return render(<BatchReviewBlock
    detail={detail}
    batches={batches}
    blocked={false}
    boardActionPending={false}
    pendingAction={null}
    offline={false}
    note=""
    onNoteChange={noop}
    onNoteSent={noop}
    error={null}
    setError={noop}
    onSelectBatch={noop}
    onActionAccepted={noop}
    onActionOutcome={noop}
  />);
}

afterEach(cleanup);

describe('BatchReviewBlock', () => {
  it('renders local-merge actions and an empty rejection note', () => {
    renderBlock('local-merge', null);

    expect(screen.getByRole('button', { name: 'Merge' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abandon' })).toBeTruthy();
    const note = screen.getByRole('textbox', { name: 'Rejection note' }) as HTMLTextAreaElement;
    expect(note.value).toBe('');
    expect(note.placeholder).toBe('Why? (required to reject)');
    expect(screen.queryByRole('link', { name: 'Open merge request' })).toBeNull();
  });

  it('renders gitlab-mr actions without a merge request link when mr_url is empty', () => {
    renderBlock('gitlab-mr', null);

    expect(screen.getByRole('button', { name: 'Mark merged' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abandon' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Rejection note' }).getAttribute('placeholder')).toBe('Why? (required to reject)');
    expect(screen.queryByRole('link', { name: 'Open merge request' })).toBeNull();
  });

  it('shows the merge request link only when mr_url is set', () => {
    renderBlock('gitlab-mr', 'https://gitlab.example/r1/merge_requests/7');

    expect(screen.getByRole('button', { name: 'Mark merged' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open merge request' }).getAttribute('href')).toBe('https://gitlab.example/r1/merge_requests/7');
  });
});
