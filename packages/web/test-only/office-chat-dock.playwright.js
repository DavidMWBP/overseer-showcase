import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.dirname(scriptDir);
const evidenceDir = process.env.OFFICE_CHAT_DOCK_EVIDENCE_DIR
  ? path.resolve(process.env.OFFICE_CHAT_DOCK_EVIDENCE_DIR)
  : await mkdtemp(path.join(os.tmpdir(), 'office-chat-dock-'));
await mkdir(evidenceDir, { recursive: true });

let server;
let baseUrl = process.env.OFFICE_CHAT_DOCK_BASE_URL;
if (!baseUrl) {
  server = await createServer({ configFile: path.join(webRoot, 'vite.config.ts'), root: webRoot,
    server: { host: '127.0.0.1', port: 5293, strictPort: true } });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
}
const port = new URL(baseUrl).port;
assert.ok(!['4400', '5173', '5174'].includes(port), `Refusing a reserved live port: ${port}`);

// The room's stage has the 1680x1056 world aspect, which sets the widths where the dock rule (stage width ≥ 640 and content width ≥ stage
// width + 380) docks.
const stageAspect = 1680 / 1056;

let browser;
const pages = [];
try {
  browser = await chromium.launch({ headless: true });

  async function open(width, height, query = '') {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    pages.push(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${baseUrl}/test-only/office-chat-dock.html${query}`);
    await page.locator('.office-stage').waitFor();
    await page.locator('.office-stage-pixi canvas').waitFor();
    await page.waitForFunction(() => {
      const office = document.querySelector('.office');
      const stage = document.querySelector('.office-stage');
      return !!office && !!stage && office.getBoundingClientRect().width > 0 && stage.getBoundingClientRect().width > 0;
    });
    return page;
  }

  /** A character takes the pointer on the canvas, at the centre of its hit area; its button carries the name and keyboard route. */
  const clickCharacter = async (page, character) => {
    const box = await character.boundingBox();
    assert.ok(box, 'Pixi character has no hit box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };

  const measure = (page) => page.evaluate(() => {
    const main = document.querySelector('main');
    const office = document.querySelector('.office');
    const home = document.querySelector('.office-home');
    const stage = document.querySelector('.office-stage');
    const needs = document.querySelector('.office-needs');
    const strip = document.querySelector('.office-needs-strip');
    const dock = document.querySelector('.office-chat-dock');
    if (!main || !office || !home || !stage || !needs) throw new Error('Office fixture did not render its measured content and stage');
    const mainStyle = getComputedStyle(main);
    const officeRect = office.getBoundingClientRect();
    const homeRect = home.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const needsRect = needs.getBoundingClientRect();
    const dockRect = dock?.getBoundingClientRect() ?? null;
    const pane = document.querySelector('.detail');
    const paneRect = pane?.getBoundingClientRect() ?? null;
    const paneStyle = pane ? getComputedStyle(pane) : null;
    const box = (rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height });
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    // Desktop: one button over each room object. Phones: the count row under the room, one button per object.
    const props = [...document.querySelectorAll('.office-room-props [data-office-prop], .office-count-row [data-office-count]')].map((node) => {
      const value = node.querySelector('.office-count-value');
      return {
        key: node.dataset.officeProp ?? node.dataset.officeCount,
        ariaLabel: node.getAttribute('aria-label'),
        value: value?.textContent?.trim() ?? null,
        rect: box(node.getBoundingClientRect()),
        valueRect: value ? box(value.getBoundingClientRect()) : null,
        valueScrollWidth: value?.scrollWidth ?? 0,
        valueClientWidth: value?.clientWidth ?? 0,
        buttonScrollWidth: node.scrollWidth,
        buttonClientWidth: node.clientWidth,
      };
    });
    const overlapPairs = [];
    for (let i = 0; i < props.length; i++) for (let j = i + 1; j < props.length; j++) if (overlaps(props[i].rect, props[j].rect)) overlapPairs.push([props[i].key, props[j].key]);
    const longest = strip ? [...strip.querySelectorAll('.needs-title')].sort((a, b) => (b.textContent ?? '').length - (a.textContent ?? '').length)[0] : null;
    const longestStyle = longest ? getComputedStyle(longest) : null;
    // An object button follows its object in the world, so only its part inside the stage box (which clips) can be covered.
    const visible = (rect) => {
      const left = Math.max(rect.left, stageRect.left);
      const right = Math.min(rect.right, stageRect.right);
      const top = Math.max(rect.top, stageRect.top);
      const bottom = Math.min(rect.bottom, stageRect.bottom);
      return { left, right, top, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    };
    const needsPropsOverlap = props.some((prop) => {
      const shown = prop.key && document.querySelector(`.office-stage [data-office-prop="${prop.key}"]`) ? visible(prop.rect) : prop.rect;
      return shown.width > 0 && shown.height > 0 && overlaps(needsRect, shown);
    });
    const chars = [...document.querySelectorAll('.office-char')];
    const row = document.querySelector('.office-count-row');
    const rowRect = row?.getBoundingClientRect() ?? null;
    const plansRect = document.querySelector('.office-plans-row')?.getBoundingClientRect() ?? null;
    const nextNeedsRowRect = document.querySelector('.office-needs-strip .needs-row')?.getBoundingClientRect() ?? null;
    return {
      contentWidth: officeRect.width,
      contentHeight: officeRect.height,
      homeWidth: homeRect.width,
      mainContentWidth: main.getBoundingClientRect().width - parseFloat(mainStyle.paddingLeft) - parseFloat(mainStyle.paddingRight),
      stageWidth: stageRect.width,
      stageHeight: stageRect.height,
      needsHeight: needsRect.height,
      needsContentWidth: needsRect.width,
      plansWidth: plansRect?.width ?? null,
      nextNeedsRowWidth: nextNeedsRowRect?.width ?? null,
      needsItemCount: strip?.querySelectorAll('.needs-row').length ?? 0,
      hasNeedsStrip: !!strip,
      needsPropsOverlap,
      props,
      overlapPairs,
      charCount: chars.length,
      propsInStage: document.querySelectorAll('.office-stage [data-office-prop]').length,
      pillCount: document.querySelectorAll('.office-props-layer, .office-prop').length,
      chipRow: rowRect ? { height: rowRect.height, top: rowRect.top, stageBottom: stageRect.bottom, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth } : null,
      longestTitle: longest ? { text: longest.textContent, width: longest.clientWidth, scrollWidth: longest.scrollWidth, whiteSpace: longestStyle.whiteSpace, overflow: longestStyle.overflow, textOverflow: longestStyle.textOverflow } : null,
      dockWidth: dockRect?.width ?? 0,
      gap: dockRect ? dockRect.left - stageRect.right : null,
      paneOverlapWidth: paneRect && dockRect ? Math.max(0, Math.min(paneRect.right, dockRect.right) - Math.max(paneRect.left, dockRect.left)) : 0,
      panePosition: paneStyle?.position ?? null,
      paneZIndex: paneStyle?.zIndex ?? null,
      pageWidth: document.documentElement.scrollWidth,
      mainWidth: main.clientWidth,
      mainHeight: main.clientHeight,
      mainScrollWidth: main.scrollWidth,
      mainScrollHeight: main.scrollHeight,
    };
  });

  const log = (label, width, height, sizes) => console.log(
    `PASS ${label} ${width}x${height}: C=${sizes.contentWidth.toFixed(2)} home=${sizes.homeWidth.toFixed(2)} needs=${sizes.needsHeight.toFixed(2)} stage=${sizes.stageWidth.toFixed(2)}x${sizes.stageHeight.toFixed(2)} props=${sizes.props.length}${sizes.chipRow ? ` chip-row=${sizes.chipRow.height.toFixed(2)}` : ''}${sizes.plansWidth !== null ? ` plans=${sizes.plansWidth.toFixed(2)}/${sizes.needsContentWidth.toFixed(2)}${sizes.nextNeedsRowWidth !== null ? ` next=${sizes.nextNeedsRowWidth.toFixed(2)}` : ''}` : ''} main-overflow=${Math.max(0, sizes.mainScrollHeight - sizes.mainHeight).toFixed(2)}px dock=${sizes.dockWidth.toFixed(2)} gap=${sizes.gap === null ? 'none' : sizes.gap.toFixed(2)}${sizes.paneOverlapWidth > 0 ? ` pane-overlap=${sizes.paneOverlapWidth.toFixed(2)}` : ''}`,
  );
  const assertContentBox = (sizes, width, label) => {
    assert.ok(Math.abs(sizes.contentWidth - sizes.mainContentWidth) <= 1, `${label}: Office width is not the main content box ${JSON.stringify(sizes)}`);
    assert.ok(sizes.pageWidth <= width, `${label}: page scrolls sideways (${JSON.stringify(sizes)})`);
  };
  const inside = (outer, inner) => inner && inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
  const assertMilestoneEffects = async (width, height) => {
    const label = `${width}x${height} milestone effects`;
    const page = await open(width, height, '?items=0#office');
    await page.evaluate(() => {
      const trigger = window.__officeChatDockTriggerMilestone;
      if (!trigger) throw new Error('Office milestone fixture trigger is missing');
      trigger('verify_passed');
    });
    await page.waitForFunction(() => document.querySelector('canvas')?.dataset.officeQaScreen === 'pass');
    const screen = await page.evaluate(() => {
      const stage = document.querySelector('.office-stage');
      const canvas = document.querySelector('canvas');
      if (!stage || !canvas) throw new Error('Pixi QA wall screen milestone did not render');
      return { stageWidth: stage.clientWidth, state: canvas.dataset.officeQaScreen, reduced: canvas.dataset.officeReduced };
    });
    assert.ok(screen.stageWidth > 0, `${label}: the Pixi stage is not visible (${JSON.stringify(screen)})`);
    assert.equal(screen.state, 'pass', `${label}: the QA wall screen shows the wrong milestone (${JSON.stringify(screen)})`);
    assert.equal(screen.reduced, 'true', `${label}: reduced motion was not reported for the milestone (${JSON.stringify(screen)})`);

    await page.evaluate(() => {
      const trigger = window.__officeChatDockTriggerMilestone;
      if (!trigger) throw new Error('Office milestone fixture trigger is missing');
      trigger('merged');
    });
    await page.waitForFunction(() => document.querySelector('canvas')?.dataset.officeReduced === 'true');
    const canvasState = await page.evaluate(() => {
      const stage = document.querySelector('.office-stage');
      const canvas = document.querySelector('canvas');
      if (!stage || !canvas) throw new Error('Pixi merge milestone did not render');
      return { stageWidth: stage.clientWidth, confettiPieces: canvas.dataset.officeConfettiPieces, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, reduced: canvas.dataset.officeReduced };
    });
    assert.ok(canvasState.stageWidth > 0 && canvasState.pageWidth <= canvasState.viewportWidth, `${label}: Pixi effects escape the stage (${JSON.stringify(canvasState)})`);
    assert.equal(canvasState.confettiPieces, '0', `${label}: reduced-motion Pixi rendered confetti (${JSON.stringify(canvasState)})`);
    assert.equal(canvasState.reduced, 'true', `${label}: reduced motion was not passed to Pixi (${JSON.stringify(canvasState)})`);
    assertContentBox(await measure(page), width, label);
    console.log(`PASS ${label}: QA wall screen shows pass; reduced-motion merge draws no confetti`);
  };
  const assertOfficeHome = async (width, height, itemCount, { largeCounts = false, screenshot = false } = {}) => {
    const label = `${width}x${height} with ${itemCount} items${largeCounts ? ' and large counts' : ''}`;
    const page = await open(width, height, `?items=${itemCount}${largeCounts ? '&large=1' : ''}#office`);
    await page.locator('.office-room-props [data-office-prop], .office-count-row [data-office-count]').first().waitFor();
    if (itemCount > 0) await page.locator('[data-testid="needs-strip"]').waitFor();
    const sizes = await measure(page);
    assertContentBox(sizes, width, label);
    assert.ok(Math.abs(sizes.homeWidth - sizes.mainContentWidth) <= 1, `${label}: Office home is not the measured main content box ${JSON.stringify(sizes)}`);
    assert.ok(sizes.mainScrollWidth <= sizes.mainWidth, `${label}: main scrolls sideways (${JSON.stringify(sizes)})`);
    if (width === 390 || width === 360) {
      const maxMainOverflow = width === 390 ? 0 : 36;
      const mainOverflow = Math.max(0, sizes.mainScrollHeight - sizes.mainHeight);
      assert.ok(mainOverflow <= maxMainOverflow, `${label}: main vertical overflow is ${mainOverflow}px; maximum is ${maxMainOverflow}px (${JSON.stringify(sizes)})`);
    }
    // The strip shows at most PHONE_CAP (3) item rows in the phone layout and DESKTOP_CAP (6) otherwise, then its +N more row.
    assert.equal(sizes.needsItemCount, Math.min(itemCount, width < 768 ? 3 : 6), `${label}: strip item count changed (${JSON.stringify(sizes)})`);
    assert.equal(sizes.hasNeedsStrip, itemCount > 0, `${label}: empty/non-empty strip visibility is wrong (${JSON.stringify(sizes)})`);
    const count = largeCounts ? '618' : String(itemCount);
    const columns = [['ready', 'Ready'], ['blocked', 'Blocked'], ['running', 'Running'], ['verifying', 'Verifying'], ['review', 'Review'], ['done', 'Done']];
    const chatName = 'Open Chat, ' + count + ' ' + (count === '1' ? 'question' : 'questions');
    const reviewName = 'Open Review, ' + count + ' ' + (count === '1' ? 'batch' : 'batches') + ' in review';
    assert.equal(sizes.charCount, 2, `${label}: expected the worker and orchestrator characters (${JSON.stringify(sizes)})`);
    assert.deepEqual(sizes.overlapPairs, [], `${label}: Office object buttons cover each other (${JSON.stringify(sizes.overlapPairs)})`);
    if (width < 768) {
      assert.deepEqual(sizes.props.map(({ key, value, ariaLabel }) => [key, value, ariaLabel]), [
        ['questions', count, chatName], ['in-review', count, reviewName],
        ...columns.map(([key, name]) => [key, count, `Open Board, ${name}: ${count}`]),
      ], `${label}: a count row item's number or name changed (${JSON.stringify(sizes.props)})`);
      assert.equal(sizes.propsInStage, 0, `${label}: phone object buttons are drawn in the room (${JSON.stringify(sizes)})`);
      assert.ok(sizes.chipRow && sizes.chipRow.top >= sizes.chipRow.stageBottom, `${label}: the count row is not under the stage (${JSON.stringify(sizes.chipRow)})`);
      assert.ok(sizes.chipRow.scrollWidth <= sizes.chipRow.clientWidth, `${label}: the count row scrolls sideways (${JSON.stringify(sizes.chipRow)})`);
      assert.ok(sizes.props.every((prop) => prop.rect.height === 44), 'a count row button is not 44 px tall (' + JSON.stringify(sizes.props) + ')');
      assert.ok(sizes.props.every((prop) => prop.rect.top === sizes.props[0].rect.top), `${label}: the count row wraps onto a second line (${JSON.stringify(sizes.props)})`);
      assert.ok(sizes.props.every((prop) => inside(prop.rect, prop.valueRect) && prop.valueScrollWidth <= prop.valueClientWidth && prop.buttonScrollWidth <= prop.buttonClientWidth), `${label}: a count row button clips its number (${JSON.stringify(sizes.props)})`);
      assert.ok(sizes.plansWidth !== null && Math.abs(sizes.plansWidth - sizes.needsContentWidth) <= 1, `${label}: Plans does not span the Needs content width (${JSON.stringify(sizes)})`);
      if (itemCount > 0) assert.ok(Math.abs(sizes.plansWidth - sizes.nextNeedsRowWidth) <= 1, `${label}: Plans width differs from the next strip row (${JSON.stringify(sizes)})`);
    } else {
      assert.deepEqual(sizes.props.map(({ key, ariaLabel }) => [key, ariaLabel]), [
        ['questions', chatName], ['review', reviewName], ['board', `Open Board, ${columns.map(([, name]) => `${name}: ${count}`).join(', ')}`],
      ], `${label}: an Office object button has an unexpected name (${JSON.stringify(sizes.props)})`);
      assert.equal(sizes.chipRow, null, `${label}: desktop rendered the phone count row (${JSON.stringify(sizes.chipRow)})`);
      assert.equal(sizes.propsInStage, 3, 'desktop object buttons left the room (' + JSON.stringify(sizes) + ')');
      assert.equal(sizes.pillCount, 0, `${label}: desktop still draws count pills (${JSON.stringify(sizes)})`);
      assert.ok(sizes.props.every((prop) => Math.min(prop.rect.width, prop.rect.height) >= 24), `${label}: an object button is under 24 CSS px (${JSON.stringify(sizes.props)})`);
      assert.ok(sizes.plansWidth !== null && Math.abs(sizes.plansWidth - sizes.needsContentWidth) <= 1, `${label}: Plans does not span the Needs content width (${JSON.stringify(sizes)})`);
    }
    assert.equal(sizes.needsPropsOverlap, false, `${label}: the needs strip covers an Office object button (${JSON.stringify(sizes)})`);
    if (itemCount === 5) {
      assert.ok(sizes.longestTitle?.width > 0 && sizes.longestTitle.scrollWidth > sizes.longestTitle.width, `${label}: the longest title is not clipped inside its row (${JSON.stringify(sizes.longestTitle)})`);
      assert.equal(sizes.longestTitle.whiteSpace, 'nowrap', `${label}: the longest title wraps (${JSON.stringify(sizes.longestTitle)})`);
      assert.equal(sizes.longestTitle.overflow, 'hidden', `${label}: the longest title does not clip (${JSON.stringify(sizes.longestTitle)})`);
      assert.equal(sizes.longestTitle.textOverflow, 'ellipsis', `${label}: the longest title has no ellipsis (${JSON.stringify(sizes.longestTitle)})`);
    }
    log(`Office home ${itemCount} items`, width, height, sizes);
    if (screenshot) await page.screenshot({ path: path.join(evidenceDir, `office-home-${width}x${height}-${itemCount}-items${largeCounts ? '-large' : ''}.png`), fullPage: false });
    return sizes;
  };
  const assertNeedsBatchDrawer = async (width, height, mergeMode, action) => {
    const label = `${width}x${height} Needs batch drawer`;
    const page = await open(width, height, `?items=5&mergeMode=${mergeMode}#office`);
    await page.getByRole('button', { name: /^batch: Lessons from overseer/ }).click();
    const pane = page.getByRole('complementary', { name: 'Batch details for r1-b33' });
    await pane.waitFor();
    const merge = pane.getByRole('button', { name: action });
    const reject = pane.getByRole('button', { name: 'Reject' });
    for (const [control, name] of [[merge, action], [reject, 'Reject']]) {
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height, `${label}: ${name} is not reachable in the drawer (${JSON.stringify(box)})`);
    }
    const sizes = await page.evaluate(() => {
      const pane = document.querySelector('.batch-pane');
      const main = document.querySelector('main');
      if (!pane || !main) throw new Error('Needs batch pane is missing');
      const rect = pane.getBoundingClientRect();
      return { hash: location.hash, viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth, mainWidth: main.clientWidth, mainScrollWidth: main.scrollWidth, paneLeft: rect.left, paneRight: rect.right, paneWidth: rect.width };
    });
    assert.equal(sizes.hash, '#office', `${label}: opening the drawer changed the view (${JSON.stringify(sizes)})`);
    assert.ok(sizes.pageWidth <= width && sizes.mainScrollWidth <= sizes.mainWidth, `${label}: horizontal page overflow (${JSON.stringify(sizes)})`);
    assert.ok(sizes.paneLeft >= 0 && sizes.paneRight <= width, `${label}: drawer extends past the viewport (${JSON.stringify(sizes)})`);
    console.log(`PASS ${label}: ${action} and Reject are reachable; no horizontal overflow (${JSON.stringify(sizes)})`);
  };
  const assertDockFocusedAtLatest = async (page, label) => {
    await page.waitForFunction(() => {
      const dock = document.querySelector('.office-chat-dock');
      const composer = dock?.querySelector('textarea[aria-label="Message the orchestrator"]');
      const thread = dock?.querySelector('.thread');
      return composer && thread && document.activeElement === composer && thread.scrollHeight - thread.clientHeight - thread.scrollTop <= 24;
    });
    const state = await page.evaluate(() => {
      const dock = document.querySelector('.office-chat-dock');
      const composer = dock?.querySelector('textarea[aria-label="Message the orchestrator"]');
      const thread = dock?.querySelector('.thread');
      return { focused: document.activeElement === composer, bottomGap: thread ? thread.scrollHeight - thread.clientHeight - thread.scrollTop : Infinity };
    });
    assert.equal(state.focused, true, `${label}: dock composer did not receive focus`);
    assert.ok(state.bottomGap <= 24, `${label}: dock thread ended ${state.bottomGap} px short of the bottom`);
  };

  const assertNeedsQuestionFocus = async (width, height, docked) => {
    const label = `${width}x${height} Needs question`;
    const page = await open(width, height, '?items=5#office');
    await page.getByRole('button', { name: 'question: Should the endpoint require auth?' }).click();
    await page.waitForFunction((expectDocked) => {
      const question = document.querySelector('.question-page-active');
      const answer = question?.querySelector('textarea[aria-label="Your answer"]');
      const office = document.querySelector('.office-hold');
      const chatTab = document.querySelector('[data-view="chat"]');
      return document.activeElement === answer && (document.querySelector('.office-chat-dock') !== null) === expectDocked
        && (expectDocked ? !office?.hasAttribute('hidden') : chatTab?.classList.contains('active'));
    }, docked);
    const state = await page.evaluate(() => {
      const question = document.querySelector('.question-page-active');
      const answer = question?.querySelector('textarea[aria-label="Your answer"]');
      return {
        question: question?.querySelector('.question-text')?.textContent ?? null,
        answerFocused: document.activeElement === answer,
        docked: document.querySelector('.office-chat-dock') !== null,
        officeActive: !document.querySelector('.office-hold')?.hasAttribute('hidden'),
        chatActive: document.querySelector('[data-view="chat"]')?.classList.contains('active') ?? false,
      };
    });
    assert.deepEqual(state, {
      question: 'Should the endpoint require auth?', answerFocused: true, docked, officeActive: docked, chatActive: !docked,
    }, `${label}: Needs did not select and focus the requested answer`);
    console.log(`PASS ${label}: document.activeElement is that question's Your answer textarea; ${docked ? 'Office stays open' : 'Chat opens'}`);
  };

  // The second dock-wide size also runs the orchestrator focus checks. The room's wide stage leaves 1920x1080 without a
  // dock, so the checks run at 2560x1080 and 1920x1080 is in the no-dock list below.
  const focusWidth = 2560;
  for (const [width, height, label] of [[2030, 1060, 'dock-wide'], [focusWidth, 1080, 'dock-wide']]) {
    const plain = await open(width, height, '?dock=0');
    const without = await measure(plain);
    assert.equal(without.dockWidth, 0, `${label} ${width}: baseline unexpectedly has a dock`);
    const page = await open(width, height, width === focusWidth ? '?longest=1#office' : '');
    await page.locator('.office-chat-dock').waitFor();
    await page.locator('.office-chat-dock .thread').waitFor();
    const withDock = await measure(page);
    assertContentBox(withDock, width, `${label} ${width}`);
    assert.ok(Math.abs(withDock.stageWidth - without.stageWidth) <= 1, `${label} ${width}: the room stage changed when Chat docked (${JSON.stringify({ withDock, without })})`);
    assert.ok(withDock.dockWidth >= 340 && withDock.dockWidth <= 400, `${label} ${width}: dock width is outside 340–400 px (${JSON.stringify(withDock)})`);
    assert.ok(Math.abs(withDock.gap - 20) <= 1, `${label} ${width}: room to dock gap is not 20 px (${JSON.stringify(withDock)})`);
    await page.locator('.office-chat-dock .msg').first().waitFor();
    if (width === focusWidth) {
      const thread = page.locator('.office-chat-dock .thread');
      const maxScroll = await thread.evaluate((element) => element.scrollHeight - element.clientHeight);
      assert.ok(maxScroll > 24, `${width}x${height}: fixture thread does not overflow enough to test latest scrolling (${maxScroll} px)`);
      const orchestrator = page.getByRole('button', { name: 'claude · sonnet · orchestrator (focus Chat)' });
      await thread.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
      await clickCharacter(page, orchestrator);
      await assertDockFocusedAtLatest(page, `${width}x${height} orchestrator click`);
      assert.equal(new URL(page.url()).hash, '#office', `${width}x${height}: clicking the orchestrator changed the Office hash`);

      await thread.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
      await orchestrator.focus();
      await orchestrator.press('Enter');
      await assertDockFocusedAtLatest(page, `${width}x${height} orchestrator Enter`);
      assert.equal(new URL(page.url()).hash, '#office', `${width}x${height}: pressing Enter on the orchestrator changed the Office hash`);
      console.log(`PASS ${width}x${height} orchestrator click and Enter focus the Chat composer, scroll to latest and keep #office`);
    }
    log(`${label} with dock`, width, height, withDock);
    log(`${label} without dock`, width, height, without);
    if (width === 2030) await page.screenshot({ path: path.join(evidenceDir, 'office-chat-dock-2030x1060.png'), fullPage: true });
    if (width === focusWidth) await page.screenshot({ path: path.join(evidenceDir, `office-chat-dock-${width}x1080.png`), fullPage: true });
  }

  {
    const width = 1440, height = 900;
    const plain = await open(width, height, '?dock=0');
    const without = await measure(plain);
    const page = await open(width, height, '#office');
    const withDockProp = await measure(page);
    assertContentBox(withDockProp, width, '1440x900');
    assert.equal(withDockProp.dockWidth, 0, '1440x900: dock rendered below its measured-width gate');
    assert.ok(Math.abs(withDockProp.stageWidth - without.stageWidth) <= 1, `1440x900: stage differs from today's undocked width (${JSON.stringify({ withDockProp, without })})`);
    const heightCap = (withDockProp.contentHeight - 128) * stageAspect;
    assert.ok(Math.abs(withDockProp.stageWidth - Math.min(withDockProp.contentWidth, heightCap)) <= 1, `1440x900: stage differs from its existing content/height cap (${JSON.stringify(withDockProp)})`);
    log('no dock baseline', width, height, withDockProp);
    await page.screenshot({ path: path.join(evidenceDir, 'office-chat-dock-1440x900-no-dock.png'), fullPage: true });
    await clickCharacter(page, page.getByRole('button', { name: 'claude · sonnet · orchestrator (opens Chat)' }));
    await page.waitForFunction(() => document.querySelector('.office-hold')?.hasAttribute('hidden') && !document.querySelector('.office-chat-dock'));
    assert.equal(await page.getByRole('button', { name: 'Chat', exact: true }).getAttribute('class'), 'active', '1440x900: clicking the orchestrator did not switch to Chat');
    assert.equal(await page.getByRole('textbox', { name: 'Message the orchestrator' }).isVisible(), true, '1440x900: Chat composer is not visible after the click');
    console.log('PASS 1440x900 orchestrator click switches to Chat with no dock');
  }

  for (const width of [1920, 1400, 1199, 1001, 1000, 768, 767]) {
    const height = width === 1920 ? 1080 : 900;
    const page = await open(width, height);
    const sizes = await measure(page);
    assertContentBox(sizes, width, `${width}x${height}`);
    assert.equal(sizes.dockWidth, 0, `${width}x${height}: dock rendered below its measured-width gate (${JSON.stringify(sizes)})`);
    assert.ok(sizes.pageWidth <= width, `${width}x${height}: page has sideways scroll (${JSON.stringify(sizes)})`);
    log('no dock at breakpoint', width, height, sizes);
  }

  {
    const width = 390, height = 844;
    const page = await open(width, height);
    const sizes = await measure(page);
    assertContentBox(sizes, width, '390x844');
    assert.equal(sizes.dockWidth, 0, '390x844: phone rendered the dock');
    assert.ok(sizes.pageWidth <= width && sizes.mainScrollWidth <= sizes.mainWidth, `390x844: sideways scroll (${JSON.stringify(sizes)})`);
    log('no dock on phone', width, height, sizes);
    await page.screenshot({ path: path.join(evidenceDir, 'office-chat-dock-390x844-phone.png'), fullPage: true });
  }

  for (const [width, height] of [[390, 844], [360, 780]]) {
    for (const itemCount of [0, 5]) await assertOfficeHome(width, height, itemCount);
    await assertOfficeHome(width, height, 5, { largeCounts: true, screenshot: width === 390 });
  }
  for (const itemCount of [0, 5]) await assertOfficeHome(1280, 800, itemCount);
  for (const width of [767, 768]) await assertOfficeHome(width, 844, 5);
  console.log('PASS Office layout matrix: the eight-item count row at 390x844 and 360x780 with 0/5 items and three-digit counts, one line of 44 px buttons with no horizontal overflow; 767/768 breakpoint edge and 1280x800 desktop with three object buttons of at least 24 px in the room and no pills; Plans spans the Needs row');
  await assertNeedsBatchDrawer(390, 844, 'local-merge', 'Merge');
  await assertNeedsBatchDrawer(1280, 800, 'gitlab-mr', 'Mark merged');
  // The room's wide stage leaves 1280x800 without a dock, so the docked case runs at 2560x1080.
  await assertNeedsQuestionFocus(1280, 800, false);
  await assertNeedsQuestionFocus(2560, 1080, true);
  await assertNeedsQuestionFocus(390, 844, false);
  await assertMilestoneEffects(390, 844);
  await assertMilestoneEffects(1280, 800);

  {
    const width = 2030, height = 1060;
    const page = await open(width, height, '?longest=1#office');
    await page.locator('.office-chat-dock').waitFor();
    await page.locator('.office-chat-dock .msg').first().waitFor();
    const beforePane = await measure(page);
    await clickCharacter(page, page.getByRole('button', { name: /claude · sonnet · ov-3/ }));
    await page.getByRole('complementary', { name: 'Details of ov-3' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.detail')?.getAttribute('aria-busy') === 'false');
    const withPane = await measure(page);
    assert.ok(withPane.dockWidth >= 340 && withPane.dockWidth <= 400, `2030x1060 with task pane: dock is missing or has the wrong width (${JSON.stringify(withPane)})`);
    assert.ok(Math.abs(withPane.stageWidth - beforePane.stageWidth) <= 1, `2030x1060 with task pane: stage width changed (${JSON.stringify({ beforePane, withPane })})`);
    assert.ok(withPane.paneOverlapWidth > 0, `2030x1060: task pane does not overlay the Chat column (${JSON.stringify(withPane)})`);
    assert.equal(withPane.panePosition, 'fixed', '2030x1060: task pane is not the existing fixed sheet');
    assert.equal(withPane.paneZIndex, '2', '2030x1060: task pane is not painted over docked Chat');
    log('task pane overlays dock', width, height, withPane);
    await page.screenshot({ path: path.join(evidenceDir, 'office-chat-dock-2030x1060-task.png'), fullPage: true });

    const thread = page.locator('.office-chat-dock .thread');
    const maxScroll = await thread.evaluate((element) => element.scrollHeight - element.clientHeight);
    assert.ok(maxScroll > 24, `2030x1060: fixture thread does not overflow enough to test latest scrolling (${maxScroll} px)`);
    const orchestrator = page.getByRole('button', { name: 'claude · sonnet · orchestrator (focus Chat)' });
    await thread.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await clickCharacter(page, orchestrator);
    await page.getByRole('complementary', { name: 'Details of ov-3' }).waitFor({ state: 'detached' });
    await assertDockFocusedAtLatest(page, '2030x1060 orchestrator click with task pane open');
    assert.equal(new URL(page.url()).hash, '#office', '2030x1060: clicking the orchestrator changed the Office hash');

    await clickCharacter(page, page.getByRole('button', { name: /claude · sonnet · ov-3/ }));
    await page.getByRole('complementary', { name: 'Details of ov-3' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.detail')?.getAttribute('aria-busy') === 'false');
    await thread.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await orchestrator.focus();
    await orchestrator.press('Enter');
    await page.getByRole('complementary', { name: 'Details of ov-3' }).waitFor({ state: 'detached' });
    await assertDockFocusedAtLatest(page, '2030x1060 orchestrator Enter with task pane open');
    assert.equal(new URL(page.url()).hash, '#office', '2030x1060: pressing Enter on the orchestrator changed the Office hash');
    console.log('PASS 2030x1060 orchestrator click and Enter close the task pane, focus Chat and keep #office');
  }

  {
    const width = focusWidth, height = 1080;
    const page = await open(width, height, '?longest=1&attachments=4');
    const dock = page.locator('.office-chat-dock');
    await dock.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.office-chat-dock .attachment-pending').length === 4);
    await page.getByText(/Longest thread message:/).waitFor();
    const overflow = await dock.evaluate((element) => {
      const dockRect = element.getBoundingClientRect();
      const selectors = ['.chat', '.thread', '.pinned', '.composer', '.attachments-pending', '.attachment-pending', '.composer-bar', 'textarea', 'select', '.msg-user'];
      const boxes = [...new Set(selectors.flatMap((selector) => [...element.querySelectorAll(selector)]))].map((node) => {
        const rect = node.getBoundingClientRect();
        const scrollContent = node.closest('.thread') !== null;
        return { selector: node.className || node.tagName.toLowerCase(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, scrollContent };
      }).filter((box) => box.right > box.left && (box.left < dockRect.left - 1 || box.right > dockRect.right + 1 || (!box.scrollContent && (box.top < dockRect.top - 1 || box.bottom > dockRect.bottom + 1))));
      return { boxes, attachmentCount: element.querySelectorAll('.attachment-pending').length, dock: { left: dockRect.left, right: dockRect.right, top: dockRect.top, bottom: dockRect.bottom } };
    });
    assert.equal(overflow.attachmentCount, 4, `${width}x${height}: expected four pending attachments (${JSON.stringify(overflow)})`);
    assert.deepEqual(overflow.boxes, [], `${width}x${height}: Chat content overflows the dock (${JSON.stringify(overflow)})`);
    log('long message and four attachments', width, height, await measure(page));
  }

  console.log(`Evidence: ${evidenceDir}`);
} finally {
  for (const page of pages) await page.close();
  if (browser) await browser.close();
  if (server) await server.close();
}
