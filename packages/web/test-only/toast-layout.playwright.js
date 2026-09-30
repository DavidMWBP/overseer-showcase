import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.dirname(root);
const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'toast-layout-'));
const server = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { host: '127.0.0.1', port: 0, strictPort: true },
});
let browser;
const short = 'Discussion sent to chat.';
const long = 'Could not send the discussion to chat: the connection ended before the reply arrived, so please try again after reconnecting.';

try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
  browser = await chromium.launch({ headless: true });
  const url = `http://127.0.0.1:${address.port}/test-only/toast-layout.html`;
  for (const width of [360, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.goto(url);
    for (const [name, message, kind] of [['short', short, 'success'], ['long', long, 'failure']]) {
      await page.evaluate(([text, variant]) => window.showToast(text, variant), [message, kind]);
      await page.getByText(message).waitFor();
      const size = await page.evaluate(() => {
        const toast = document.querySelector('.toast');
        const text = toast.querySelector('.toast-text');
        const close = toast.querySelector('.toast-dismiss');
        const card = toast.getBoundingClientRect();
        const message = text.getBoundingClientRect();
        const button = close.getBoundingClientRect();
        const line = parseFloat(getComputedStyle(text).lineHeight) || parseFloat(getComputedStyle(text).fontSize) * 1.2;
        return { cardWidth: card.width, cardHeight: card.height, cardRight: card.right, cardLeft: card.left, textWidth: message.width, textHeight: message.height, textTop: message.top, buttonTop: button.top, buttonRight: button.right, buttonWidth: button.width, buttonHeight: button.height, line, scrollWidth: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth };
      });
      const expectedLines = name === 'short' ? 1 : 3;
      const lines = Math.round(size.textHeight / size.line);
      if (lines !== expectedLines || size.buttonTop > size.textTop + size.line || size.buttonRight > size.cardRight || size.buttonWidth < 44 || size.buttonHeight < 44 || size.scrollWidth > size.viewport || size.cardRight > size.viewport || size.cardLeft < 0 || (name === 'short' && size.cardHeight > 46)) {
        throw new Error(`${width}px ${name}: ${JSON.stringify({ ...size, lines })}`);
      }
      if (width === 390) await page.screenshot({ path: path.join(evidenceDir, `${name}-390.png`) });
      console.log(`PASS ${width}px ${name}: ${JSON.stringify({ ...size, lines })}`);
    }
    await page.close();
  }
  console.log(`Screenshots: ${evidenceDir}`);
} finally {
  await browser?.close();
  await server.close();
}
