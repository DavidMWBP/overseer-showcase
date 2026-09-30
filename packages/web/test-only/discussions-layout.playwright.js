import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.dirname(root);
const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'overseer-discussions-layout-'));
const server = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { host: '127.0.0.1', port: 0, strictPort: true },
});
let browser;

try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
  const base = `http://127.0.0.1:${address.port}/test-only/discussions-layout.html`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await page.route('**/api/discussions/d-1/attachments/*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  const results = [];
  for (const width of [360, 390, 600, 767, 768, 900]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [name, url] of [['list', base], ['thread', `${base}?thread`]]) {
      await page.goto(url);
      await page.getByText('https://example.com/', { exact: false }).first().waitFor();
      if (name === 'list') {
        await page.locator('.discussion-form input[type="file"]').setInputFiles(Array.from({ length: 4 }, (_, i) => ({
          name: `pending-${i + 1}.png`, mimeType: 'image/png', buffer: png,
        })));
        await page.locator('.attachment-pending').nth(3).waitFor();
      } else {
        const images = page.locator('.discussion-question-attachments img');
        await images.evaluateAll((items) => items.forEach((img) => { img.loading = 'eager'; }));
        await page.waitForFunction(() => [...document.querySelectorAll('.discussion-question-attachments img')].every((img) => img.complete && img.naturalWidth > 0));
        await page.addStyleTag({ content: '.discussion-question-attachments img { width: 800px; }' });
      }
      const sizes = await page.evaluate(() => {
        const main = document.querySelector('main');
        const style = getComputedStyle(main);
        const attachmentSelector = location.search.includes('thread') ? '.discussion-question-attachments' : '.attachments-pending';
        const attachmentRow = document.querySelector(attachmentSelector);
        const attachmentImages = [...document.querySelectorAll(`${attachmentSelector} img`)];
        const row = attachmentRow.getBoundingClientRect();
        const right = Math.max(0, ...attachmentImages.map((img) => img.getBoundingClientRect().right));
        return {
          viewport: document.documentElement.clientWidth,
          page: document.documentElement.scrollWidth,
          main: main.clientWidth,
          available: main.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          view: document.querySelector('.discussions-view').getBoundingClientRect().width,
          content: main.scrollWidth,
          attachmentRow: attachmentSelector,
          attachmentRowWidth: attachmentRow.clientWidth,
          attachmentRight: right,
          attachmentContainerRight: row.right,
          attachmentCount: attachmentImages.length,
          attachmentOverflow: attachmentRow.scrollWidth > attachmentRow.clientWidth || right > row.right + 1,
        };
      });
      if (sizes.attachmentCount !== 4 || sizes.page > sizes.viewport || sizes.content > sizes.main || sizes.view > sizes.available || sizes.attachmentOverflow) {
        throw new Error(`${name} ${width}px overflow: ${JSON.stringify(sizes)}`);
      }
      if (width === 360 || width === 390) await page.screenshot({ path: path.join(evidenceDir, `discussions-${name}-${width}.png`), fullPage: true });
      results.push({ name, width, ...sizes });
    }
  }
  console.log(`PASS: ${results.length} layout states; screenshots: ${evidenceDir}`);
  console.log(JSON.stringify(results));
} finally {
  await browser?.close();
  await server.close();
}
