import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// The Office strip's loading placeholder against the strip it stands in for: the API is held until the placeholder has been
// measured, then released, so each skeleton row is compared with the arrived row in the same page and at the same width.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.dirname(scriptDir);
const evidenceDir = process.env.OFFICE_STRIP_LAYOUT_EVIDENCE_DIR
  ? path.resolve(process.env.OFFICE_STRIP_LAYOUT_EVIDENCE_DIR)
  : await mkdtemp(path.join(os.tmpdir(), 'office-strip-layout-'));
await mkdir(evidenceDir, { recursive: true });

const VIEWPORTS = [
  { width: 390, height: 844, dpr: 3 },
  { width: 768, height: 1024, dpr: 1 },
  { width: 1280, height: 800, dpr: 1 },
  { width: 1920, height: 1080, dpr: 1 },
];
// 7 is over both caps (3 on a phone, 6 from 768 px), so the strip shows its +N more control and the placeholder its shape.
const ITEM_COUNTS = [0, 1, 3, 7];
const TOLERANCE = 2;

const repo = {
  id: 'r1', path: 'C:/office-strip-fixture', base_branch: 'main', verify_command: null, review_command: null, setup_command: null,
  merge_mode: 'local-merge', batch_approver: 'user', worker_limit: 2, review_rounds: 2,
};
const bead = (id, title, extra = {}) => ({ id, title, description: '', status: 'open', priority: 2, labels: [], notes: '', assignee: null, closed_at: null, dependency_count: 0, ...extra });
const card = (id, title, column, state, extra = {}) => ({
  bead: bead(id, title), repo_id: 'r1', batch_id: null, column, state, harness: null, branch: null, cost: null, elapsed_ms: null,
  session_status: null, session_id: null, verify_block: 'none', verify_failure: null, tier: null, model: null, account: null,
  account_name: null, account_label: null, findings: null, accepted_note: null, ...extra,
});
const batchTitles = ['Trend chart on the usage page', 'Office strip placeholder rows', 'Review table keeps its columns'];
const batch = (i) => ({
  id: `r1-b${i + 1}`, origin_chat_id: null, linked_chat_ids: [], repo_id: 'r1', title: batchTitles[i % batchTitles.length], branch: `feature/b${i + 1}`,
  base_branch: 'main', status: 'review', note: null, history: null, mr_url: null, conflict_files: null,
  created_at: '2026-09-26T10:00:00.000Z', updated_at: '2026-09-26T10:00:00.000Z', merged_at: null, merged_commit: null, setup_at: null,
  waiting_on: null, overlap_files: null, beads_total: 2, beads_done: 2, beads_closed: 2, cost: 0.5, cost_unknown: 0,
});
// Two ready, one blocked and one running card, so the loaded props read 2, 1 and 1 against a placeholder that reads none.
const cards = [card('ov-1', 'Ready one', 'ready', 'idle'), card('ov-2', 'Ready two', 'ready', 'idle'), card('ov-3', 'Blocked', 'blocked', 'blocked'), card('ov-4', 'Running', 'running', 'running', { session_status: 'running', session_id: 's4', harness: 'claude' })];
const responsesFor = (items) => ({
  '/api/repos': [repo],
  '/api/doctor': { tools: [], data_dir: { path: 'C:/office-strip-fixture-data', ok: true, problem: null } },
  '/api/settings/orchestrator': { model: null, effort: null, promptOverride: null },
  '/api/settings/tiers': { tiers: [], denyModels: [] },
  '/api/status': { bd_ok: true, orchestrator: { status: 'idle', native_session_id: null, last_activity_at: null, busy: false, model: null, context: null } },
  '/api/daemon': { pid: 1, started_at: '2026-09-26T00:00:00.000Z', commit: 'fixture', source_head: 'fixture', restart_needed: false },
  '/api/board': { bd_ok: true, repos: [{ repo, batches: Array.from({ length: items }, (_, i) => batch(i)), cards }] },
  '/api/chat': { rows: [], has_more: false, oldest_id: null },
  '/api/costs': { repos: [], batches: [] },
  '/api/plans': [],
  '/api/plans/all': [],
});

const server = await createServer({ configFile: path.join(webRoot, 'vite.config.ts'), root: webRoot,
  server: { host: '127.0.0.1', port: 5297, strictPort: true } });
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
const baseUrl = `http://127.0.0.1:${address.port}`;
assert.ok(!['4400', '5173', '5174'].includes(String(address.port)), `Refusing a reserved live port: ${address.port}`);

const failures = [];
let checks = 0;
const check = (condition, message) => { checks++; if (!condition) failures.push(message); };
const round = (value) => Math.round(value * 10) / 10;
const table = [];
let browser;

/**
 * Every strip row's box, the Plans row first, plus each prop's box and text. Tops are measured from the strip's own top, since
 * the phone header gains its repository chip row when the repositories arrive and moves the whole page, strip included.
 */
const measure = async (page, loading) => {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate((loading) => {
  const strip = document.querySelector('.office-needs');
  const stripTop = strip.getBoundingClientRect().top;
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height, top: r.top - stripTop }; };
  const scope = loading ? strip.querySelector('[data-testid="shimmer"]') : strip;
  if (!scope) throw new Error(loading ? 'the strip is not loading' : 'the strip is missing');
  if (!loading && strip.querySelector('[data-testid="shimmer"]')) throw new Error('the strip is still loading');
  const rows = [...scope.querySelectorAll('.needs-row')];
  const marks = rows.map((row) => box(row.querySelector('.needs-mark')));
  // The text a reader sees: not the library's hidden measuring copy (its placeholder 0 is transparent), its style, or the status label.
  const visibleText = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement.closest('.shimmer-measure-container, style, .visually-hidden')) text += node.textContent;
    }
    return text.trim();
  };
  // The room objects' buttons on desktop (their chip text and name), the count row's buttons on phones.
  const props = [...document.querySelectorAll('.office-room-prop, .office-count')].map((el) => ({ ...box(el), text: visibleText(el), name: el.getAttribute('aria-label') ?? '', shimmer: !!el.querySelector('[data-testid="shimmer"]') }));
  const stage = document.querySelector('.office-stage');
  // A placeholder row shows the arrived row's card: visible, with its border.
  const cards = rows.map((row) => { const s = getComputedStyle(row); return { visible: s.visibility === 'visible', border: parseFloat(s.borderTopWidth), background: s.backgroundColor }; });
  // The length of each title's text (not its row-wide block), which is what the shimmer bar stands in for.
  const titleBlocks = rows.map((row) => row.querySelector('.needs-title').getBoundingClientRect().width);
  // The placeholder's bar is its title's inner span, which the library paints; the loaded title is its text, clipped to its line.
  const titles = rows.map((row, i) => {
    const title = row.querySelector('.needs-title');
    if (loading) return title.firstElementChild.getBoundingClientRect().width;
    const range = document.createRange();
    range.selectNodeContents(title);
    return Math.min(range.getBoundingClientRect().width, titleBlocks[i]);
  });
  const more = scope.querySelector('.needs-more');
  return { more: more ? { ...box(more), text: visibleText(more) } : null, rows: rows.map(box), marks, cards, titles, titleBlocks, props, strip: { ...box(strip), pageTop: stripTop }, stage: stage ? box(stage) : null };
  }, loading);
};

try {
  browser = await chromium.launch({ headless: true });
  for (const viewport of VIEWPORTS) {
    for (const items of ITEM_COUNTS) {
      const label = `${viewport.width}x${viewport.height} items=${items}`;
      const mobile = viewport.width < 768;
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.dpr, hasTouch: mobile, isMobile: mobile });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      // As if the strip had last loaded with this many rows in this browser.
      await page.addInitScript((n) => localStorage.setItem('overseer.officeStripRows', String(n)), items);
      const responses = responsesFor(items);
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      const unhandled = [];
      await page.route('**/api/**', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        await released;
        if (!Object.hasOwn(responses, pathname)) {
          unhandled.push(pathname);
          await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'unhandled fixture route' }) });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responses[pathname]) });
      });
      await page.routeWebSocket('**/api/events', async (socket) => { await released; socket.send(JSON.stringify({ type: 'office_snapshot', sessions: [] })); });

      await page.goto(`${baseUrl}/#office`);
      await page.locator('.office-needs [data-testid="shimmer"]').waitFor();
      await page.locator(mobile ? '.office-count [data-testid="shimmer"]' : '.office-room-prop').first().waitFor();
      const before = await measure(page, true);
      await page.screenshot({ path: path.join(evidenceDir, `${viewport.width}x${viewport.height}-items${items}-loading.png`) });
      release();
      await page.waitForFunction(() => !document.querySelector('.office-needs [data-testid="shimmer"]') && !document.querySelector('.office-count [data-testid="shimmer"]'));
      await page.getByRole('button', { name: 'plans' }).waitFor();
      const after = await measure(page, false);
      // The room's textures fade in after the strip has loaded; the capture waits for them, the measurement does not need to.
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(evidenceDir, `${viewport.width}x${viewport.height}-items${items}-loaded.png`) });
      const stored = await page.evaluate(() => localStorage.getItem('overseer.officeStripRows'));

      check(unhandled.length === 0, `${label}: unhandled mocked API requests ${JSON.stringify(unhandled)}`);
      // The strip shows at most 3 item rows on a phone and 6 above, then its +N more control.
      const shown = Math.min(items, mobile ? 3 : 6);
      check(before.rows.length === shown + 1, `${label}: placeholder has ${before.rows.length} rows, expected ${shown + 1}`);
      check(after.rows.length === shown + 1, `${label}: loaded strip has ${after.rows.length} rows, expected ${shown + 1}`);
      // Over the cap: the arrived +N more control and the placeholder's shape of it share one box.
      check(!!before.more === items > shown && !!after.more === items > shown, `${label}: more control loading ${!!before.more}, loaded ${!!after.more}, expected ${items > shown}`);
      if (after.more) check(after.more.text === `+${items - shown} more`, `${label}: more control reads ${after.more.text}`);
      if (before.more && after.more) {
        for (const edge of ['left', 'right', 'width', 'height', 'top']) {
          check(Math.abs(before.more[edge] - after.more[edge]) <= TOLERANCE, `${label} more: skeleton ${edge} ${round(before.more[edge])} vs loaded ${round(after.more[edge])}`);
        }
        table.push({ viewport: label, row: 'more', skeleton: `${round(before.more.left)}..${round(before.more.right)} w${round(before.more.width)} h${round(before.more.height)} top${round(before.more.top)}`, loaded: `${round(after.more.left)}..${round(after.more.right)} w${round(after.more.width)} h${round(after.more.height)} top${round(after.more.top)} "${after.more.text}"`, mark: '' });
      }
      check(stored === String(items), `${label}: stored row count ${stored}, expected ${items}`);
      for (let i = 0; i < Math.min(before.rows.length, after.rows.length); i++) {
        const s = before.rows[i];
        const l = after.rows[i];
        const name = i === 0 ? 'plans' : `item ${i}`;
        table.push({ viewport: label, row: name, skeleton: `${round(s.left)}..${round(s.right)} w${round(s.width)} h${round(s.height)} top${round(s.top)}`, loaded: `${round(l.left)}..${round(l.right)} w${round(l.width)} h${round(l.height)} top${round(l.top)}`, mark: `title ${round(before.titles[i])} / ${round(after.titles[i])} icon ${round(before.marks[i].width)}x${round(before.marks[i].height)} / ${round(after.marks[i].width)}x${round(after.marks[i].height)}` });
        for (const edge of ['left', 'right', 'width', 'height', 'top']) {
          check(Math.abs(s[edge] - l[edge]) <= TOLERANCE, `${label} ${name}: skeleton ${edge} ${round(s[edge])} vs loaded ${round(l[edge])}`);
        }
        for (const edge of ['left', 'width', 'height']) {
          check(Math.abs(before.marks[i][edge] - after.marks[i][edge]) <= TOLERANCE, `${label} ${name}: skeleton icon ${edge} ${round(before.marks[i][edge])} vs loaded ${round(after.marks[i][edge])}`);
        }
        // Plans reads the same word in both; an item's title is the user's own text, so only its bar being text-length is checked.
        if (i === 0) check(Math.abs(before.titles[0] - after.titles[0]) <= TOLERANCE, `${label} plans: skeleton title ${round(before.titles[0])} px vs loaded ${round(after.titles[0])} px`);
        else check(before.titles[i] <= before.titleBlocks[i] + 0.5 && (before.titleBlocks[i] < 250 || before.titles[i] < before.titleBlocks[i] - 20), `${label} ${name}: skeleton title bar ${round(before.titles[i])} px against its ${round(before.titleBlocks[i])} px line`);
        const [sc, lc] = [before.cards[i], after.cards[i]];
        check(sc.visible && sc.border === lc.border && sc.background === lc.background, `${label} ${name}: skeleton card ${JSON.stringify(sc)} vs loaded ${JSON.stringify(lc)}`);
      }
      // Phones: eight count row buttons that shimmer with no digit; desktop: three object buttons whose chip and name carry no digit.
      const propCount = mobile ? 8 : 3;
      check(before.props.length === propCount && after.props.length === propCount, `${label}: ${before.props.length} count controls loading, ${after.props.length} loaded, expected ${propCount}`);
      check(before.props.every((p) => (!mobile || p.shimmer) && !/\d/.test(p.text) && !/\d/.test(p.name)), `${label}: a loading count control shows a digit or no shimmer ${JSON.stringify(before.props.map((p) => [p.text, p.name]))}`);
      check(after.props.every((p) => !p.shimmer && /\d/.test(p.text)), `${label}: a loaded count control shows no count ${JSON.stringify(after.props.map((p) => p.text))}`);
      for (let i = 0; i < Math.min(before.props.length, after.props.length); i++) {
        for (const edge of ['left', 'width', 'height', 'top']) {
          check(Math.abs(before.props[i][edge] - after.props[i][edge]) <= TOLERANCE, `${label} prop ${i}: loading ${edge} ${round(before.props[i][edge])} vs loaded ${round(after.props[i][edge])}`);
        }
      }
      table.push({ viewport: label, row: 'props', skeleton: before.props.map((p) => `${round(p.left)}/w${round(p.width)}/h${round(p.height)}`).join(' '), loaded: after.props.map((p) => `${round(p.left)}/w${round(p.width)}/h${round(p.height)} "${p.text.trim()}"`).join(' '), mark: '' });
      check(before.stage && after.stage && Math.abs(before.stage.top - after.stage.top) <= TOLERANCE, `${label}: the room moves from ${round(before.stage?.top ?? -1)} to ${round(after.stage?.top ?? -1)} below the strip when it loads`);
      if (after.stage) table.push({ viewport: label, row: 'strip/stage', skeleton: `strip page top ${round(before.strip.pageTop)} ${round(before.strip.left)}..${round(before.strip.right)} stage ${round(before.stage?.left ?? -1)}..${round(before.stage?.right ?? -1)} top${round(before.stage?.top ?? -1)}`, loaded: `strip page top ${round(after.strip.pageTop)} ${round(after.strip.left)}..${round(after.strip.right)} stage ${round(after.stage.left)}..${round(after.stage.right)} top${round(after.stage.top)}`, mark: '' });
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server.close();
}

for (const row of table) console.log(`${row.viewport} | ${row.row} | skeleton ${row.skeleton} | loaded ${row.loaded}${row.mark ? ` | icon ${row.mark}` : ''}`);
console.log(`evidence: ${evidenceDir}`);
if (failures.length) {
  console.error(`${failures.length} of ${checks} checks failed:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`office strip layout: ${checks} checks passed`);
