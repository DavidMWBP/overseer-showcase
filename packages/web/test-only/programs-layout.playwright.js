import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.dirname(root);
const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'programs-layout-'));
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
  // 390 is the phone; 767 and 768 sit on either side of the phone breakpoint; 1280 is desktop.
  for (const [width, oneColumn] of [[390, true], [767, false], [768, false], [1280, false]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`http://127.0.0.1:${address.port}/test-only/programs-layout.html`);
    await page.locator('.program-entry-text').first().waitFor();
    const sizes = await page.evaluate(() => {
      const main = document.querySelector('main');
      const program = document.querySelector('.program');
      const lefts = [...document.querySelectorAll('.program-lane')].map((l) => Math.round(l.getBoundingClientRect().left));
      return {
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
        main: main.clientWidth,
        mainContent: main.scrollWidth,
        program: program.clientWidth,
        programContent: program.scrollWidth,
        laneColumns: new Set(lefts).size,
      };
    });
    const overflow = sizes.page > sizes.viewport || sizes.mainContent > sizes.main || sizes.programContent > sizes.program;
    if (overflow || (oneColumn && sizes.laneColumns !== 1) || (!oneColumn && sizes.laneColumns < 2)) {
      throw new Error(`Programs layout at ${width}px: ${JSON.stringify(sizes)}`);
    }
    await page.screenshot({ path: path.join(evidenceDir, `programs-${width}.png`), fullPage: true });
    console.log(`PASS ${width}px ${JSON.stringify(sizes)}`);
    await page.close();
  }
  console.log(`screenshots: ${evidenceDir}`);
} finally {
  await browser?.close();
  await server.close();
}
