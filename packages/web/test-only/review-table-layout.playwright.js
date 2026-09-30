import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.dirname(root);
const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'review-table-layout-'));
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
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  await page.goto(`http://127.0.0.1:${address.port}/test-only/review-table-layout.html`);
  await page.getByText('wide table').waitFor();
  const sizes = await page.evaluate(() => {
    const container = document.querySelector('.plain-table-scroll');
    const detail = document.querySelector('.review-detail');
    return {
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      detail: detail.clientWidth,
      detailContent: detail.scrollWidth,
      container: container.clientWidth,
      table: container.scrollWidth,
    };
  });
  if (sizes.table <= sizes.container || sizes.page > sizes.viewport || sizes.detailContent > sizes.detail) {
    throw new Error(`Review table overflow: ${JSON.stringify(sizes)}`);
  }
  await page.screenshot({ path: path.join(evidenceDir, 'review-table-360.png'), fullPage: true });
  console.log(`PASS: Review table scrolls at 360px; screenshot: ${evidenceDir}`);
  console.log(JSON.stringify(sizes));
} finally {
  await browser?.close();
  await server.close();
}
