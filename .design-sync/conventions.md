# Overseer design conventions

Overseer is a dark-only local dashboard with Office as its home and Board, Chat, Review and Setup views. The needs-you strip and Plans row sit above the Office room. This project ships its tokens, app stylesheet and 11 React components on `window.Overseer`: use the components for Board, Review and shell pieces, and build the rest from plain HTML/JSX elements styled with the classes and `var(--*)` tokens below. Do not invent new colours or class names.

## Setup
No provider or wrapper. `styles.css` imports `_ds_bundle.css`, which sets `color-scheme: dark`, the IBM Plex fonts (Google Fonts import), the tokens and base styles on `:root`, `body`, `button`, `input`, `select`, `textarea`, `code`, `pre`. Put every screen on `var(--bg)`: the app has no light theme, and its text colours are unreadable on white. Base `button` is already styled; add `class="primary"` (accent fill), `class="danger"` (red outline) or `class="link"` (text-only).

## Components (`window.Overseer.*`)
| Component | Use for | Place it in |
|---|---|---|
| `Card` | a bead on the Board (status chip from `card.state`) | a `.column` (about 200-240px wide) |
| `BatchRow` | one batch: title, branch, progress, cost, status chip | a `.batches` list |
| `Activity` | the running-workers strip above the Board columns | the Board, full width |
| `Rail` | the left navigation rail with view badges, repo costs and mascot | a 232px column, full viewport height |
| `Diff` | a unified git diff, one collapsible block per file | a pane or Review detail |
| `PlainText` | review notes and findings; `tables` renders pipe tables | a text block |
| `UsageChart` | cost or tokens per day, stacked by model | a Usage card |
| `Mascot` | the orchestrator's state (idle, thinking, working, asking, sleeping, offline, error) | the rail status, or anywhere 32-96px |
| `Loading` | a shimmer over the arrived content's shape | around the block that waits on data |
| `Toasts` | action results, bottom-right; show one with `window.Overseer.pushToast('success' \| 'failure', text)` | once per screen |
| `AttachmentPicker` | image attachments in a composer; `state` comes from `window.Overseer.useAttachments()` | a `.composer` |

Every component's props (the shapes of `card`, `batch`, `stacks` and the rest) are in `components/general/<Name>/<Name>.d.ts`, with worked examples in `<Name>.prompt.md`.

## Tokens (in `_ds_bundle.css`)
| Purpose | Token |
|---|---|
| Surfaces | `--bg` #151b23, `--surface` #1c2430, `--surface-2` #232d3a |
| Lines | `--line`, `--border` (alias of line) |
| Text | `--text`, `--muted` |
| Accent | `--accent` #6f9ad1 |
| Board column states | `--ready`, `--running`, `--verifying`, `--review`, `--done`, `--blocked` |
| Feedback | `--ok`, `--warn` |
| Chart series (fixed order; a seventh folds into "Other") | `--chart-1` … `--chart-6` |
| Type | `--sans` (IBM Plex Sans), `--mono` (IBM Plex Mono) |
| Shape | `--radius` 6px |

Base type is 14px/1.5; code and metadata are 12px in `--mono`.

## Layout classes in `_ds_bundle.css`
- Shell: `.app` (232px rail + content grid, 100vh), `.rail`, `.rail-repo`, `.rail-views`, `.rail-status`.
- Board: `.board`, `.board-repo`, `.columns`, `.column`, `.card`, `.card-title`, `.card-meta`, `.card-selected`, `.card-failed`, `.card-abandoned`, `.card-batch`, `.batches`, `.batch`, `.batch-title`, `.batch-merged`, `.chip`, `.count`.
- Card detail pane: `.detail`, `.detail-actions`, `.pre`, `.trace`, `.diff`, `.diff-add`, `.diff-del`, `.diff-hunk`, `.diff-meta`.
- Chat: `.chat`, `.thread`, `.chat-day`, `.msg`, `.msg-group-start`, `.msg-user`, `.msg-assistant`, `.msg-system`, `.msg-answer`, `.msg-role`, `.msg-time`, `.msg-time-hover`, `.question`, `.question-text`, `.question-actions`, `.composer`.
- Review: `.review-layout`, `.review-list`, `.review-detail`, `.review-head`, `.review-beads`, `.review-actions`, `.review-history`.
- Setup: `.setup`, `.repo-form`, `.form-actions`, `.path-row`, `.dialog-backdrop`, `.dialog`, `.dialog-head`, `.dialog-path`, `.browse-filter`, `.browse-list`.
- Feedback: `.muted`, `.ok`, `.badge-warn`, `.banner-warn`, `.dot-warn`, `.row-warn`, `.row-bad`, `.mascot`, `.refreshing`.

## Where the truth lives
Read `_ds_bundle.css` (reached through `styles.css`) before styling; its selectors are the full vocabulary, so read a class's rule before using it. Read a component's `.d.ts` and `.prompt.md` before passing it props.

## Example
```jsx
const { Card } = window.Overseer;

<div style={{ background: 'var(--bg)', padding: 16 }}>
  <div className="column" style={{ width: 220 }}>
    <h3>Running <span className="count">1</span></h3>
    <Card selected={false} onClick={() => {}} card={{
      bead: { id: 'overseer-4fq', title: 'Add day separators to the chat thread', description: '', status: 'in_progress', priority: 2, labels: [], notes: '', assignee: null, closed_at: null, dependency_count: 0 },
      repo_id: 'overseer', batch_id: 'b-7k2m', column: 'running', state: 'running', harness: 'codex', branch: 'overseer/b-7k2m',
      cost: 0.42, elapsed_ms: 312000, session_status: 'running', session_id: 's-19', verify_failure: null, verify_block: 'none',
      tier: 'standard', model: 'gpt-5.6-terra', account_name: null, account_label: null, findings: null, accepted_note: null,
    }} />
    <button className="primary">Re-dispatch</button>
  </div>
</div>
```
