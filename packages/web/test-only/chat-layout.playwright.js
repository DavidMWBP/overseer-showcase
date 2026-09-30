import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

// Reading position across a view change and Jump to latest, with a 150-row thread (i1t6's cases).
async function readingChecks(browser, name, deviceScaleFactor, port) {
  for (const banner of ['none', 'offline']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor, hasTouch: true });
    const url = `http://127.0.0.1:${port}/test-only/chat-layout.html?rows=150&banner=${banner === 'none' ? '' : banner}`;
    const gap = () => page.getByRole('log').evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.goto(url);
    await page.getByText('Message 150:', { exact: false }).waitFor();
    await settle();
    // Two rows arrive while scrolled up, so they are unread until the user scrolls down to them.
    await page.getByRole('log').evaluate((el) => { el.scrollTop = 0; });
    await settle();
    await page.evaluate(() => window.__arrive(2));
    await page.getByRole('button', { name: 'Jump to latest · 2 new' }).waitFor();
    // Scroll down to 3 px short of the end, as the iPhone's touch scroll stops, then switch away and let 2 more rows arrive.
    // Read inside the scroll event, after Chat's handler: the Jump control then leaves and the thread grows into the 3 px.
    const { short, readAtScroll } = await page.getByRole('log').evaluate((el) => new Promise((resolve) => {
      el.addEventListener('scroll', () => resolve({ short: el.scrollHeight - el.clientHeight - el.scrollTop, readAtScroll: window.__readThrough.current }), { once: true });
      el.scrollTop = el.scrollHeight - el.clientHeight - 3;
    }));
    assert.equal(short, 3, `${name} ${banner}: thread did not stop 3 px short`);
    assert.equal(readAtScroll, 152, `${name} ${banner}: 3 px short did not record reading at the scroll`);
    await settle();
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    const readThrough = await page.evaluate(() => window.__readThrough.current);
    await page.evaluate(() => window.__arrive(2));
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByText('Arrival 154', { exact: true }).waitFor();
    await settle();
    const back = await page.evaluate(() => {
      const thread = document.querySelector('.thread');
      return { top: thread.scrollTop, client: thread.clientHeight, height: thread.scrollHeight,
        divider: document.querySelector('.chat-unread-divider')?.nextElementSibling?.textContent ?? null,
        jump: document.querySelector('.chat-jump') !== null };
    });
    const returnUnread = 154 - readThrough;
    const returnGap = back.height - back.client - back.top;
    assert.equal(readThrough, 152, `${name} ${banner}: leaving ${short} px short did not record reading`);
    assert.equal(returnUnread, 2, `${name} ${banner}: returnUnread`);
    assert.ok(returnGap <= 1, `${name} ${banner}: not at the bottom after return ${JSON.stringify(back)}`);
    assert.ok(back.divider?.includes('Arrival 153'), `${name} ${banner}: divider not above the first arrival ${JSON.stringify(back)}`);
    assert.equal(back.jump, false, `${name} ${banner}: jump button shown at the bottom`);
    console.log(`PASS ${name} dpr${deviceScaleFactor} ${banner} return 3px-short 2-arrivals: short=${short} readAtScroll=${readAtScroll} readThrough=${readThrough} returnUnread=${returnUnread} top=${back.top} client=${back.client} height=${back.height} gap=${returnGap} jump=${back.jump}`);
    // Jump to latest from 100 rows up.
    await page.getByText('Message 55:', { exact: false }).evaluate((el) => {
      const thread = el.closest('.thread');
      thread.scrollTop = el.getBoundingClientRect().top - thread.getBoundingClientRect().top + thread.scrollTop;
    });
    await settle();
    await page.evaluate(() => window.__arrive(1));
    const jump = page.getByRole('button', { name: /Jump to latest · \d+ new/ });
    await jump.waitFor();
    await jump.click();
    await settle();
    const jumpGap = await gap();
    assert.ok(jumpGap <= 1, `${name} ${banner}: Jump to latest ended ${jumpGap} px short`);
    assert.equal(await page.locator('.chat-jump').count(), 0, `${name} ${banner}: jump button still shown`);
    console.log(`PASS ${name} dpr${deviceScaleFactor} ${banner} jump from 100 rows up: gap=${jumpGap}`);
    await page.close();
  }
}

async function jumpReadChecks(browser, port) {
  const failures = [];
  for (const width of [360, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: width >= 768 ? 800 : 844 }, hasTouch: width < 768 });
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.goto(`http://127.0.0.1:${port}/test-only/chat-layout.html?rows=60`);
    await page.getByText('Message 60:', { exact: false }).waitFor();
    await settle();
    const thread = page.getByRole('log');
    const scrollUp = await thread.evaluate((el) => {
      const from = el.scrollTop;
      el.scrollTop = Math.max(0, from - 300);
      return { from, to: el.scrollTop };
    });
    assert.equal(scrollUp.from - scrollUp.to, 300, `${width}: initial scroll was not 300 px`);
    await settle();
    await page.evaluate(() => window.__arrive(1));
    const jump = page.getByRole('button', { name: 'Jump to latest · 1 new' });
    await jump.waitFor();
    await jump.click();
    await settle();
    const jumpGap = await thread.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    assert.ok(jumpGap <= 1, `${width}: Jump to latest ended ${jumpGap} px short`);
    const afterJumpScroll = await thread.evaluate((el) => {
      const from = el.scrollTop;
      el.scrollTop = Math.max(0, from - 300);
      return { from, to: el.scrollTop };
    });
    assert.equal(afterJumpScroll.from - afterJumpScroll.to, 300, `${width}: post-jump scroll was not 300 px`);
    await settle();
    const jumpButton = page.locator('.chat-jump');
    const button = await jumpButton.count() === 0 ? null : await jumpButton.textContent();
    if (button !== null) failures.push({ width, button });
    console.log(`${button === null ? 'PASS' : 'FAIL'} jump then scroll up 300 px ${width}: button=${button}`);
    await page.close();
  }
  assert.deepEqual(failures, [], `Jump to latest reappeared after its rows were read: ${JSON.stringify(failures)}`);
}

async function commandSuggestionChecks(browser, port, evidenceDir) {
  for (const width of [360, 767, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width < 768 });
    await page.goto(`http://127.0.0.1:${port}/test-only/chat-layout.html`);
    await page.getByText('Message 60:', { exact: false }).waitFor();
    await page.getByLabel('Message the orchestrator').fill('/');
    await page.getByRole('listbox', { name: 'Chat command suggestions' }).waitFor();
    const layout = await page.evaluate(() => {
      const chat = document.querySelector('.chat');
      const list = document.querySelector('.chat-command-list');
      const composer = document.querySelector('.composer');
      const listBox = list.getBoundingClientRect();
      const composerBox = composer.getBoundingClientRect();
      const listViewport = { top: listBox.top + list.clientTop, bottom: listBox.top + list.clientTop + list.clientHeight };
      const rows = [...list.querySelectorAll('.chat-command-option')];
      const visibleRows = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > listViewport.top && rect.top < listViewport.bottom;
      }).length;
      const longest = rows[0].querySelector('.chat-command-description');
      const chatBox = chat.getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        mainWidth: document.querySelector('main').clientWidth,
        chatWidth: chat.clientWidth,
        listWidth: list.clientWidth,
        composerWidth: composer.clientWidth,
        rowCount: rows.length,
        visibleRows,
        visibleRowHeights: rows.slice(0, 8).map((row) => row.getBoundingClientRect().height),
        listHeight: list.clientHeight,
        listScrollHeight: list.scrollHeight,
        longestDescriptionLineClamp: getComputedStyle(longest).webkitLineClamp,
        longestDescriptionClientHeight: longest.clientHeight,
        longestDescriptionScrollHeight: longest.scrollHeight,
        listAboveComposer: listBox.bottom <= composerBox.top,
        composerBottom: composerBox.bottom,
        chatBottom: chatBox.bottom,
        documentWidth: document.documentElement.scrollWidth,
        chatScrollWidth: chat.scrollWidth,
      };
    });
    assert.equal(layout.rowCount, 12, `${width}: expected twelve commands for scrolling ${JSON.stringify(layout)}`);
    assert.equal(layout.visibleRows, 8, `${width}: expected eight visible rows ${JSON.stringify(layout)}`);
    assert.ok(Math.min(...layout.visibleRowHeights) >= 44, `${width}: a row is below the 44 px touch target ${JSON.stringify(layout)}`);
    assert.ok(layout.listScrollHeight > layout.listHeight, `${width}: remaining rows cannot scroll ${JSON.stringify(layout)}`);
    assert.equal(layout.longestDescriptionLineClamp, '2', `${width}: description is not clamped to two lines ${JSON.stringify(layout)}`);
    assert.ok(layout.longestDescriptionScrollHeight > layout.longestDescriptionClientHeight, `${width}: longest description is not truncated ${JSON.stringify(layout)}`);
    assert.equal(layout.listWidth, layout.composerWidth, `${width}: suggestion list is not full width ${JSON.stringify(layout)}`);
    assert.ok(layout.listAboveComposer, `${width}: list is not above the composer ${JSON.stringify(layout)}`);
    assert.ok(layout.composerBottom <= 845, `${width}: composer is outside the viewport ${JSON.stringify(layout)}`);
    assert.ok(layout.documentWidth <= width && layout.chatScrollWidth <= layout.chatWidth, `${width}: horizontal overflow ${JSON.stringify(layout)}`);
    console.log(`PASS command suggestions ${width}: ${JSON.stringify(layout)}`);
    await page.screenshot({ path: path.join(evidenceDir, `commands-${width}.png`) });
    const input = page.getByLabel('Message the orchestrator');
    for (let i = 0; i < 10; i++) await input.press('ArrowDown');
    await page.waitForFunction(() => {
      const list = document.querySelector('.chat-command-list');
      const option = list?.querySelector('[aria-selected="true"]');
      if (!list || !option) return false;
      const listBox = list.getBoundingClientRect();
      const optionBox = option.getBoundingClientRect();
      return Number(option.getAttribute('data-suggestion-index')) === 10
        && optionBox.top >= listBox.top + list.clientTop - 1
        && optionBox.bottom <= listBox.top + list.clientTop + list.clientHeight + 1;
    });
    const navigation = await page.evaluate(() => ({
      selectedIndex: Number(document.querySelector('.chat-command-option[aria-selected="true"]').getAttribute('data-suggestion-index')),
      scrollTop: document.querySelector('.chat-command-list').scrollTop,
      composerBottom: document.querySelector('.composer').getBoundingClientRect().bottom,
    }));
    assert.equal(navigation.selectedIndex, 10, `${width}: Down did not reach the 11th result ${JSON.stringify(navigation)}`);
    assert.ok(navigation.scrollTop > 0, `${width}: keyboard highlight did not scroll into view ${JSON.stringify(navigation)}`);
    assert.ok(navigation.composerBottom <= 845, `${width}: keyboard navigation moved the composer out of view ${JSON.stringify(navigation)}`);
    await page.close();
  }
}

// The pinned question card's geometry: the card against 40% of the visible height, the first question's text scroller, the answer
// box, both buttons and the pager (each must sit inside the card), and where each "- " line starts.
async function measureQuestionCard(page) {
  return page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }; };
    const pinned = document.querySelector('.pinned');
    const question = pinned.querySelector('.question-page-active .question');
    const text = question.querySelector('.question-text');
    const pager = pinned.querySelector('.question-pager');
    const [answer, dismiss] = question.querySelectorAll('.question-actions button');
    const visible = window.visualViewport ? visualViewport.height : innerHeight;
    const viewportVar = document.querySelector('.chat').style.getPropertyValue('--visual-viewport-height');
    // A "- " line starts its own line box when its first character sits at the text's left edge.
    const textLeft = text.getBoundingClientRect().left;
    const listStarts = [];
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const match of node.data.matchAll(/(^|\n)- /g)) {
        const range = document.createRange();
        const at = match.index + match[1].length;
        range.setStart(node, at); range.setEnd(node, at + 1);
        listStarts.push(Math.round(range.getBoundingClientRect().left - textLeft));
      }
    }
    return { visible, viewportVar: viewportVar ? parseFloat(viewportVar) : null, card: box(pinned), cardScroll: pinned.scrollHeight, cardClient: pinned.clientHeight,
      textScroll: text.scrollHeight, textClient: text.clientHeight, lineHeight: parseFloat(getComputedStyle(text).lineHeight) || null,
      textarea: box(question.querySelector('textarea')), answer: box(answer), dismiss: box(dismiss),
      pager: pager && getComputedStyle(pager).display !== 'none' ? box(pager) : null, composer: box(document.querySelector('.composer')),
      role: text.getAttribute('role'), name: text.getAttribute('aria-label'), tabIndex: text.tabIndex, listStarts };
  });
}

function assertQuestionCard(m, label, question, count, height) {
  const cap = (m.viewportVar ?? m.visible) * 0.4;
  assert.ok(m.card.height <= Math.ceil(cap) + 1, `${label}: card ${m.card.height} px over the ${cap} px cap ${JSON.stringify(m)}`);
  assert.ok(m.cardScroll <= m.cardClient + 1, `${label}: the card itself overflows, hiding a control ${JSON.stringify(m)}`);
  for (const key of ['textarea', 'answer', 'dismiss']) {
    assert.ok(m[key].height > 0 && m[key].top >= m.card.top && m[key].bottom <= m.card.bottom, `${label}: ${key} outside the card ${JSON.stringify(m)}`);
  }
  assert.ok(m.composer.bottom <= height + 1, `${label}: composer below the viewport ${JSON.stringify(m)}`);
  if (count > 1) {
    assert.ok(m.pager && m.pager.top >= m.card.top && m.pager.bottom <= m.card.bottom, `${label}: pager hidden ${JSON.stringify(m)}`);
  }
  if (question === 'short') {
    assert.ok(m.textScroll <= m.textClient, `${label}: short question overflows ${JSON.stringify(m)}`);
    assert.ok(m.textClient <= Math.ceil(m.lineHeight ?? 20) + 1, `${label}: short question grew past one line ${JSON.stringify(m)}`);
  } else {
    assert.ok(m.textScroll > m.textClient, `${label}: long question does not scroll inside the text ${JSON.stringify(m)}`);
    assert.equal(m.listStarts.length, 6, `${label}: expected six "- " lines ${JSON.stringify(m)}`);
    assert.ok(m.listStarts.every((x) => x === 0), `${label}: a "- " line does not start its own line ${JSON.stringify(m)}`);
  }
  assert.deepEqual([m.role, m.name, m.tabIndex], ['region', 'Question text', 0], `${label}: scroller not focusable with a name`);
}

const root = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.dirname(root);
const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'chat-layout-'));
const server = await createServer({ configFile: path.join(webRoot, 'vite.config.ts'), root: webRoot,
  server: { host: '127.0.0.1', port: 5291, strictPort: true } });
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
  browser = await chromium.launch({ headless: true });
  for (const width of [360, 390, 767, 768, 1024, 1280]) {
    for (const banner of ['offline', 'load-error', 'none']) {
      const page = await browser.newPage({ viewport: { width, height: width >= 768 ? 800 : 844 }, hasTouch: width < 768, isMobile: false });
      await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?banner=${banner === 'none' ? '' : banner}`);
      await page.getByText('Message 60:', { exact: false }).waitFor();
      const sizes = await page.evaluate(() => {
        const main = document.querySelector('main');
        const composer = document.querySelector('.composer');
        const thread = document.querySelector('.thread');
        const chat = document.querySelector('.chat');
        return { viewport: innerHeight, mainWidth: main.clientWidth, chatWidth: chat.clientWidth,
          composerBottom: composer.getBoundingClientRect().bottom, threadClient: thread.clientHeight, threadScroll: thread.scrollHeight,
          mainScroll: main.scrollHeight, mainClient: main.clientHeight };
      });
      assert.ok(sizes.composerBottom <= sizes.viewport + 1, `${banner} ${width}: composer below viewport ${JSON.stringify(sizes)}`);
      assert.ok(sizes.threadScroll > sizes.threadClient, `${banner} ${width}: thread cannot scroll ${JSON.stringify(sizes)}`);
      assert.equal(sizes.mainScroll, sizes.mainClient, `${banner} ${width}: main scrolls instead of the thread`);
      if (width === 360) {
        const chips = await page.locator('.chat-outcome').evaluateAll((els) => els.map((el) => ({ right: el.getBoundingClientRect().right, containerRight: el.parentElement.getBoundingClientRect().right, top: el.getBoundingClientRect().top, wrap: getComputedStyle(el.parentElement).flexWrap })));
        assert.equal(chips.length, 3, 'expected three outcome chips');
        assert.ok(chips.every((c) => c.wrap === 'wrap'), 'outcome stylesheet must wrap chips');
        assert.ok(chips.every((c) => c.right <= c.containerRight + 1), `outcome chip overflows: ${JSON.stringify(chips)}`);
        assert.ok(chips[2].top > chips[0].top, `outcome chips did not wrap: ${JSON.stringify(chips)}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'outcomes cause sideways page scroll');
        await page.locator('.chat-outcome').first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidenceDir, `outcomes-${banner}-360.png`) });
        console.log(`PASS outcomes ${banner} 360: ${JSON.stringify(chips)}`);
      }
      const thread = page.getByRole('log');
      await thread.evaluate((el) => { el.scrollTop = 0; });
      await thread.evaluate((el) => { el.scrollTop = 100; });
      assert.ok(await thread.evaluate((el) => el.scrollTop > 0), `${banner} ${width}: thread did not scroll`);
      console.log(`PASS ${banner} ${width}: ${JSON.stringify(sizes)}`);
      if ([390, 1280].includes(width)) await page.screenshot({ path: path.join(evidenceDir, `${banner}-${width}.png`) });
      await page.close();
    }
  }
  await commandSuggestionChecks(browser, address.port, evidenceDir);
  await jumpReadChecks(browser, address.port);
  for (const outcomes of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 360, height: 844 }, hasTouch: true });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?outcomes=${outcomes ? '1' : '0'}`);
    await page.getByText('Message 60:', { exact: false }).waitFor();
    const layout = await page.locator('.msg-user').last().evaluate((row) => {
      const time = row.querySelector('.msg-time').getBoundingClientRect();
      const status = row.querySelector('.msg-status').getBoundingClientRect();
      const stamp = row.querySelector('.msg-stamp');
      const thread = row.closest('.thread');
      return { timeTop: time.top, statusTop: status.top, statusRight: status.right, rowRight: row.getBoundingClientRect().right, threadWidth: thread.clientWidth, threadScrollWidth: thread.scrollWidth, stampDisplay: getComputedStyle(stamp).display, status: row.querySelector('.msg-status').textContent };
    });
    assert.equal(layout.status, 'Waiting');
    assert.ok(Math.abs(layout.timeTop - layout.statusTop) <= 2, `status left the time line: ${JSON.stringify(layout)}`);
    assert.ok(layout.statusRight <= layout.rowRight + 1 && layout.threadScrollWidth <= layout.threadWidth + 1, `status overflows: ${JSON.stringify(layout)}`);
    assert.equal(layout.stampDisplay, 'inline-flex', 'status stylesheet must keep the time and status together');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'status causes sideways page scroll');
    await page.locator('.msg-user').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidenceDir, `status-outcomes-${outcomes}-360.png`) });
    console.log(`PASS status 360 outcomes=${outcomes}: ${JSON.stringify(layout)}`);
    await page.close();
  }
  for (const status of ['Waiting', 'Seen', 'Answered']) {
    const page = await browser.newPage({ viewport: { width: 360, height: 844 }, hasTouch: true });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?status=${status}`);
    await page.getByText('Message 60:', { exact: false }).waitFor();
    const layout = await page.locator('.msg-user').last().evaluate((row) => {
      const stamp = row.querySelector('.msg-continuation-stamp');
      const thread = row.closest('.thread');
      const rect = stamp.getBoundingClientRect();
      return { status: stamp.querySelector('.msg-status').textContent, right: rect.right,
        rowRight: row.getBoundingClientRect().right, threadWidth: thread.clientWidth, scrollWidth: thread.scrollWidth };
    });
    assert.equal(layout.status, status);
    assert.ok(layout.right <= layout.rowRight + 1 && layout.scrollWidth <= layout.threadWidth + 1,
      `${status} scrolls sideways: ${JSON.stringify(layout)}`);
    console.log(`PASS ${status} 360: ${JSON.stringify(layout)}`);
    await page.close();
  }
  for (const width of [360, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 360 });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html`);
    await page.getByText('Message 60:', { exact: false }).waitFor();
    const layout = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.msg-user')];
      const start = rows[0];
      const continuation = rows.at(-1);
      const role = start.querySelector('.msg-role');
      const label = role.firstChild;
      const labelRange = document.createRange();
      labelRange.selectNodeContents(label);
      const time = role.querySelector('.msg-time');
      const status = role.querySelector('.msg-status');
      const thread = continuation.closest('.thread');
      return { roleHeight: role.getBoundingClientRect().height,
        label: label.textContent, labelTop: labelRange.getBoundingClientRect().top, timeTop: time.getBoundingClientRect().top,
        statusTop: status.getBoundingClientRect().top, threadWidth: thread.clientWidth, scrollWidth: thread.scrollWidth };
    });
    assert.ok(layout.label === 'You' && Math.abs(layout.labelTop - layout.timeTop) <= 2 &&
      Math.abs(layout.timeTop - layout.statusTop) <= 2 && layout.roleHeight < 20,
    `group-start role wraps at ${width}: ${JSON.stringify(layout)}`);
    assert.ok(layout.scrollWidth <= layout.threadWidth + 1, `status scrolls sideways at ${width}: ${JSON.stringify(layout)}`);
    console.log(`PASS status lines ${width}: ${JSON.stringify(layout)}`);
    await page.close();
  }
  // A continuation row rendered with the status against the same row rendered without one: the stamp shortens the first line only.
  const measureContinuation = async (width, text, status) => {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 360 });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?untracked=1&text=${text}${status ? `&status=${status}` : ''}`);
    await page.locator('.msg-user').nth(59).waitFor();
    const read = () => page.locator('.msg-user').nth(59).evaluate((row) => {
      const pre = row.querySelector('.pre');
      const range = document.createRange();
      range.selectNodeContents(pre.lastChild);
      const lines = [];
      for (const r of range.getClientRects()) {
        const line = lines.find((l) => Math.abs(l.top - r.top) < 2);
        if (line) { line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right); } else lines.push({ top: r.top, left: r.left, right: r.right });
      }
      const rowStyle = getComputedStyle(row);
      const stamp = row.querySelector('.msg-continuation-stamp');
      return { height: row.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(pre).lineHeight), lines: lines.length, line1: lines[0].right - lines[0].left, line2: lines[1] ? lines[1].right - lines[1].left : null,
        textWidth: pre.getBoundingClientRect().width, rowContentWidth: row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight),
        stampTop: stamp ? stamp.getBoundingClientRect().top : null, line1Top: lines[0].top, stampWidth: stamp ? stamp.getBoundingClientRect().width : 0 };
    });
    const before = await read();
    let hovered = null;
    if (width === 1280) { await page.locator('.msg-user').nth(59).hover(); hovered = (await read()).height; }
    await page.close();
    return { ...before, hovered };
  };
  for (const width of [360, 1280]) {
    for (const text of ['long', 'short']) {
      const plain = await measureContinuation(width, text, null);
      const answered = await measureContinuation(width, text, 'Answered');
      if (text === 'long') {
        if (width === 360) assert.ok(plain.lines >= 5, `long row has fewer than 5 lines at 360: ${JSON.stringify(plain)}`);
        assert.ok(answered.height - plain.height <= plain.lineHeight + 0.5, `status adds more than one line at ${width}: ${JSON.stringify({ plain, answered })}`);
        // Both second lines are full lines of 3-character words, so the widths match to within one word.
        assert.ok(Math.abs(answered.line2 - plain.line2) <= 20, `status shortens the second line at ${width}: ${JSON.stringify({ plain, answered })}`);
      } else {
        assert.equal(answered.lines, 1, `short row wraps at ${width}: ${JSON.stringify(answered)}`);
        assert.equal(answered.height, plain.height, `status changes the short row height at ${width}: ${JSON.stringify({ plain, answered })}`);
      }
      assert.ok(Math.abs(answered.stampTop - answered.line1Top) <= 4, `stamp left the first line at ${width}: ${JSON.stringify(answered)}`);
      assert.equal(plain.stampWidth, 0, 'a row without a status renders no stamp');
      assert.ok(Math.abs(plain.textWidth - plain.rowContentWidth) < 1, `a row without a status reserves space at ${width}: ${JSON.stringify(plain)}`);
      if (width === 1280) assert.ok(plain.hovered === plain.height && answered.hovered === answered.height, `hover changes the row height: ${JSON.stringify({ plain, answered })}`);
      console.log(`PASS continuation ${text} ${width}: no status ${JSON.stringify(plain)} / Answered ${JSON.stringify(answered)}`);
    }
  }
  for (const touch of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: touch });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html`);
    const visible = await page.locator('.composer-key-hint').isVisible();
    assert.equal(visible, !touch, `keyboard hint visibility for touch=${touch}`);
    console.log(`PASS hint touch=${touch}: visible=${visible}`);
    await page.close();
  }
  for (const count of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: 360, height: 844 }, hasTouch: true });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?repos=${count}`);
    const select = page.getByLabel('Repo');
    const send = page.getByRole('button', { name: 'Send' });
    assert.equal(await select.isVisible(), true);
    assert.ok((await send.boundingBox()).x - ((await select.boundingBox()).x + (await select.boundingBox()).width) < 20, `repo selector not beside Send for ${count} repos`);
    assert.equal(await select.inputValue(), count === 1 ? 'r1' : '?');
    if (count === 2) {
      await select.selectOption('r2');
      assert.equal(await select.inputValue(), 'r2');
      assert.ok((await send.boundingBox()).x - ((await select.boundingBox()).x + (await select.boundingBox()).width) < 20, 'selected target moved away from Send');
    }
    console.log(`PASS target repos=${count}: ${await select.inputValue()} beside Send`);
    await page.close();
  }
  for (const banner of ['none', 'offline']) {
    const page = await browser.newPage({ viewport: { width: 360, height: 844 }, hasTouch: true });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?banner=${banner === 'none' ? '' : banner}`);
    await page.getByText('Message 60:', { exact: false }).waitFor();
    // A load opens at the bottom, so the control appears only once the user has scrolled up and a row arrives.
    await page.getByRole('log').evaluate((el) => { el.scrollTop = 0; });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => window.__arrive(1));
    await page.getByRole('button', { name: 'Jump to latest · 1 new' }).waitFor();
    const sizes = await page.evaluate(() => {
      const button = document.querySelector('.chat-jump').getBoundingClientRect();
      const composer = document.querySelector('.composer').getBoundingClientRect();
      const chat = document.querySelector('.chat').getBoundingClientRect();
      return { buttonBottom: button.bottom, composerTop: composer.top, composerBottom: composer.bottom, buttonLeft: button.left, buttonRight: button.right, chatLeft: chat.left, chatRight: chat.right };
    });
    assert.ok(sizes.buttonBottom <= sizes.composerTop, `${banner}: jump overlaps composer ${JSON.stringify(sizes)}`);
    assert.ok(sizes.composerBottom <= 845 && sizes.buttonLeft >= sizes.chatLeft && sizes.buttonRight <= sizes.chatRight, `${banner}: jump outside Chat ${JSON.stringify(sizes)}`);
    console.log(`PASS jump 360 ${banner}: ${JSON.stringify(sizes)}`);
    await page.screenshot({ path: path.join(evidenceDir, `jump-${banner}-360.png`) });
    await page.close();
  }
  for (const width of [360, 390, 767, 768, 1024]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?questions=3`);
    await page.getByText('Open question 1?').waitFor();
    const layout = await page.evaluate(() => ({
      cards: [...document.querySelectorAll('.pinned .question')].filter((el) => getComputedStyle(el.parentElement).display !== 'none').length,
      counter: getComputedStyle(document.querySelector('.question-pager')).display,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      chatWidth: document.querySelector('.chat').clientWidth,
    }));
    assert.equal(layout.cards, 1, `${width}: wrong visible question count ${JSON.stringify(layout)}`);
    assert.equal(layout.counter, 'flex', `${width}: wrong pager visibility ${JSON.stringify(layout)}`);
    assert.ok(layout.scrollWidth <= layout.viewportWidth, `${width}: sideways scroll ${JSON.stringify(layout)}`);
    console.log(`PASS questions ${width}: ${JSON.stringify(layout)}`);
    if (width === 360) {
      await page.screenshot({ path: path.join(evidenceDir, 'questions-360.png') });
      await page.getByRole('button', { name: 'Next' }).click();
      assert.equal(await page.locator('.question-page-active .question-text').textContent(), 'Open question 2?');
      await page.screenshot({ path: path.join(evidenceDir, 'questions-2-360.png') });
    }
    await page.close();
  }
  for (const [width, height, question, count] of [[390, 844, 'short', 1], [390, 844, 'long', 1], [390, 480, 'long', 2], [390, 480, 'short', 2], [767, 844, 'long', 1], [768, 800, 'long', 1], [1280, 800, 'short', 1], [1280, 800, 'long', 2]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 768 });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?question=${question}&questions=${count}`);
    await page.locator('.pinned .question-text').first().waitFor();
    const m = await measureQuestionCard(page);
    const label = `question card ${question} x${count} ${width}x${height}`;
    assertQuestionCard(m, label, question, count, height);
    console.log(`PASS ${label}: ${JSON.stringify(m)}`);
    await page.close();
  }
  // Four long open questions on desktop: their controls together would overflow the cap, so one shows at a time and the pager
  // steps through all four, each within the cap with its own answer box and buttons inside the card.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?question=long&questions=4`);
    await page.locator('.pinned .question-text').first().waitFor();
    for (let n = 1; n <= 4; n++) {
      const m = await measureQuestionCard(page);
      const state = await page.evaluate(() => ({
        counter: document.querySelector('.question-pager span').textContent,
        shown: [...document.querySelectorAll('.pinned .question-text')].filter((el) => el.getClientRects().length > 0).length,
        first: document.querySelector('.question-page-active .question-text').textContent.slice(0, 12),
      }));
      const label = `desktop pager 1280x800 question ${n} of 4`;
      assert.equal(state.counter, `Question ${n} of 4`, `${label}: ${JSON.stringify(state)}`);
      assert.equal(state.shown, 1, `${label}: more than one question shown ${JSON.stringify(state)}`);
      assert.equal(state.first.startsWith(n === 1 ? 'Before' : `Question ${n}`), true, `${label}: wrong question ${JSON.stringify(state)}`);
      assertQuestionCard(m, label, 'long', 4, 800);
      console.log(`PASS ${label}: ${JSON.stringify({ ...state, card: m.card, cap: m.visible * 0.4, textarea: m.textarea, answer: m.answer, dismiss: m.dismiss, pager: m.pager })}`);
      if (n < 4) await page.getByRole('button', { name: 'Next' }).click();
    }
    assert.equal(await page.getByRole('button', { name: 'Next' }).isDisabled(), true, 'desktop pager: Next enabled on the last question');
    await page.close();
  }
  await readingChecks(browser, 'chromium', 1, address.port);
  const batchPage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await batchPage.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?panel=1`);
  await batchPage.locator('.chat-outcome').click();
  await batchPage.getByRole('complementary', { name: 'Batch details for r1-b1' }).waitFor();
  const batchLayout = await batchPage.locator('.batch-pane').evaluate((pane) => {
    const batchTitle = pane.querySelector('.batch-pane-title');
    const taskTitle = pane.querySelector('.batch-pane-task-title');
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    };
    return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, pane: rect(pane), batchTitle: rect(batchTitle), taskTitle: rect(taskTitle), batchTitleText: batchTitle.textContent, taskTitleText: taskTitle.textContent };
  });
  assert.equal(batchLayout.viewportWidth, 390);
  assert.ok(batchLayout.documentWidth <= 390, `batch panel scrolls the page sideways: ${JSON.stringify(batchLayout)}`);
  assert.ok(batchLayout.pane.left >= -1 && batchLayout.pane.right <= 391 && batchLayout.pane.top >= -1 && batchLayout.pane.bottom <= 845, `batch pane exceeds the phone: ${JSON.stringify(batchLayout)}`);
  assert.ok(batchLayout.batchTitle.right <= batchLayout.pane.right + 1 && batchLayout.batchTitle.scrollWidth <= batchLayout.batchTitle.clientWidth + 1, `long batch title overflows: ${JSON.stringify(batchLayout)}`);
  assert.equal(batchLayout.taskTitleText.length, 60);
  assert.ok(batchLayout.taskTitle.right <= batchLayout.pane.right + 1 && batchLayout.taskTitle.scrollWidth <= batchLayout.taskTitle.clientWidth + 1, `60-character task title overflows: ${JSON.stringify(batchLayout)}`);
  const batchScreenshot = path.join(evidenceDir, 'batch-panel-long-titles-390.png');
  await batchPage.screenshot({ path: batchScreenshot });
  const thread = batchPage.getByRole('log');
  const beforeClose = await thread.evaluate((element) => element.scrollTop);
  await batchPage.locator('.batch-pane .detail-back').click();
  await batchPage.locator('.batch-pane').waitFor({ state: 'detached' });
  const afterClose = await thread.evaluate((element) => element.scrollTop);
  assert.equal(afterClose, beforeClose, 'closing the batch panel changed Chat scroll position');
  console.log(`PASS batch panel 390: ${JSON.stringify(batchLayout)}; chatScrollBeforeClose=${beforeClose} afterClose=${afterClose}; screenshot=${batchScreenshot}`);
  await batchPage.close();
  await browser.close();
  browser = await webkit.launch({ headless: true });
  await readingChecks(browser, 'webkit', 3, address.port);
  for (const banner of ['none', 'offline']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await page.addInitScript(() => {
      const events = new EventTarget();
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: {
        height: 844, offsetTop: 0, scale: 1,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
      } });
    });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?banner=${banner === 'none' ? '' : banner}`);
    await page.getByText('Message 60:', { exact: false }).waitFor();
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      Object.assign(viewport, { height: 500, offsetTop: 20 });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction(() => document.querySelector('.chat')?.classList.contains('chat-visual-viewport'));
    const sizes = await page.evaluate(() => ({
      visualBottom: visualViewport.offsetTop + visualViewport.height,
      chatBottom: document.querySelector('.chat').getBoundingClientRect().bottom,
      composerBottom: document.querySelector('.composer').getBoundingClientRect().bottom,
      threadClient: document.querySelector('.thread').clientHeight,
      threadScroll: document.querySelector('.thread').scrollHeight,
    }));
    assert.ok(Math.abs(sizes.chatBottom - sizes.visualBottom) <= 1, `WebKit ${banner}: Chat misses visual viewport ${JSON.stringify(sizes)}`);
    assert.ok(sizes.composerBottom <= sizes.visualBottom + 1, `WebKit ${banner}: composer covered ${JSON.stringify(sizes)}`);
    assert.ok(sizes.threadScroll > sizes.threadClient, `WebKit ${banner}: thread cannot scroll ${JSON.stringify(sizes)}`);
    console.log(`PASS WebKit emulated keyboard ${banner}: ${JSON.stringify(sizes)}`);
    await page.close();
  }
  // The keyboard case for the question card: the cap follows the visual viewport, not the 844 px layout viewport.
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true });
    await page.addInitScript(() => {
      const events = new EventTarget();
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: {
        height: 844, offsetTop: 0, scale: 1,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
      } });
    });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?question=long&questions=2`);
    await page.locator('.pinned .question-text').first().waitFor();
    await page.evaluate(() => {
      Object.assign(window.visualViewport, { height: 480, offsetTop: 0 });
      window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForFunction(() => document.querySelector('.chat')?.classList.contains('chat-visual-viewport'));
    const m = await measureQuestionCard(page);
    assert.ok(m.viewportVar !== null && m.viewportVar <= 480, `WebKit keyboard question card: no visual viewport height ${JSON.stringify(m)}`);
    assert.ok(m.composer.bottom <= 481, `WebKit keyboard question card: composer below the keyboard ${JSON.stringify(m)}`);
    assertQuestionCard(m, 'WebKit keyboard question card long x2 390x480', 'long', 2, 844);
    console.log(`PASS WebKit keyboard question card: ${JSON.stringify(m)}`);
    await page.close();
  }
  // The iPhone keyboard (336 px plus the 44 px accessory bar leaves 464 of 844 px) with the page not panned and panned by Safari
  // (offsetTop 380): the fixed tab bar hides and gives up its reserve, so nothing covers the composer, and it returns afterwards.
  for (const [name, query] of [['composer', ''], ['short question', 'question=short'], ['long question', 'question=long'], ['three questions', 'questions=3']]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true });
    await page.addInitScript(() => {
      const events = new EventTarget();
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: {
        height: 844, offsetTop: 0, scale: 1,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
      } });
    });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/chat-layout.html?${query}`);
    await page.locator('.composer textarea').waitFor();
    if (query) await page.locator('.pinned .question-text').first().waitFor();
    const read = () => page.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      const tabBar = document.querySelector('.rail-views');
      const pinned = document.querySelector('.pinned');
      return { tabBar: getComputedStyle(tabBar).display, tabBarBox: box(tabBar), chat: box(document.querySelector('.chat')),
        composer: box(document.querySelector('.composer')), mainPaddingBottom: getComputedStyle(document.querySelector('main')).paddingBottom,
        card: pinned ? { scroll: pinned.scrollHeight, client: pinned.clientHeight } : null,
        visualBottom: visualViewport.offsetTop + visualViewport.height };
    });
    const setViewport = async (height, offsetTop) => {
      await page.evaluate(([h, o]) => {
        Object.assign(window.visualViewport, { height: h, offsetTop: o });
        window.visualViewport.dispatchEvent(new Event('resize'));
        window.visualViewport.dispatchEvent(new Event('scroll'));
      }, [height, offsetTop]);
      await page.waitForFunction((on) => document.querySelector('.chat')?.classList.contains('chat-visual-viewport') === on, height < 844);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const before = await read();
    assert.equal(before.tabBar, 'flex', `${name}: tab bar not shown without the keyboard ${JSON.stringify(before)}`);
    assert.ok(before.tabBarBox.bottom === 844 && before.composer.bottom <= before.tabBarBox.top, `${name}: no-keyboard layout changed ${JSON.stringify(before)}`);
    for (const offsetTop of [0, 380]) {
      await setViewport(464, offsetTop);
      const k = await read();
      const label = `${name} keyboard offsetTop ${offsetTop}`;
      assert.equal(k.tabBar, 'none', `${label}: tab bar still shown ${JSON.stringify(k)}`);
      assert.equal(k.mainPaddingBottom, '0px', `${label}: main still pads for the tab bar ${JSON.stringify(k)}`);
      assert.ok(Math.abs(k.chat.bottom - k.visualBottom) <= 1, `${label}: Chat does not end at the visual bottom ${JSON.stringify(k)}`);
      assert.ok(k.composer.bottom <= k.visualBottom + 1 && k.composer.top >= offsetTop, `${label}: composer outside the visible area ${JSON.stringify(k)}`);
      if (k.card) assert.ok(k.card.scroll <= k.card.client, `${label}: the card overflows its cap ${JSON.stringify(k)}`);
      await page.screenshot({ path: path.join(evidenceDir, `keyboard-${name.replace(' ', '-')}-offset${offsetTop}.png`) });
      console.log(`PASS WebKit ${label}: ${JSON.stringify(k)}`);
    }
    await setViewport(844, 0);
    const after = await read();
    assert.deepEqual(after, before, `${name}: layout after the keyboard closed differs ${JSON.stringify({ before, after })}`);
    console.log(`PASS WebKit ${name} keyboard closed: tab bar back ${JSON.stringify(after)}`);
    for (const order of ['no resize', 'resize while hidden', 'suspended frame']) {
      await setViewport(464, 0);
      await page.evaluate((order) => {
        let hidden = true;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        document.dispatchEvent(new Event('visibilitychange'));
        const raf = window.requestAnimationFrame;
        if (order === 'suspended frame') window.requestAnimationFrame = () => 999999;
        Object.assign(window.visualViewport, { height: 844, offsetTop: 0 });
        if (order !== 'no resize') window.visualViewport.dispatchEvent(new Event('resize'));
        window.requestAnimationFrame = raf;
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      }, order);
      await page.waitForFunction(() => !document.querySelector('.chat').classList.contains('chat-visual-viewport'));
      const restored = await read();
      assert.deepEqual(restored, before, `${name} ${order}: return did not restore geometry ${JSON.stringify(restored)}`);
      console.log(`PASS WebKit ${name} return ${order}: ${JSON.stringify(restored)}`);
    }
    await setViewport(464, 0);
    const open = await read();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      window.dispatchEvent(new Event('pageshow'));
    });
    assert.deepEqual(await read(), open, `${name}: return with keyboard open changed geometry`);
    await page.evaluate(() => {
      Object.assign(window.visualViewport, { height: 844, offsetTop: 0 });
      window.dispatchEvent(new Event('pageshow'));
    });
    assert.deepEqual(await read(), before, `${name}: pageshow did not restore geometry`);
    await page.screenshot({ path: path.join(evidenceDir, `return-${name.replaceAll(' ', '-')}-390.png`) });
    await page.close();
  }
  console.log(`PASS chat layout; screenshots: ${evidenceDir}`);
} finally {
  await browser?.close();
  await server.close();
}
