import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = process.env.PUBLIC_URL ?? 'https://indodax-quant.sinyalku.workers.dev';
const outputDir = resolve('artifacts/live-login-smoke');
await mkdir(outputDir, { recursive: true });

const cases = [
  { name: 'desktop-dark', width: 1440, height: 900, theme: 'dark' },
  { name: 'desktop-light', width: 1440, height: 900, theme: 'light' },
  { name: 'mobile-375-dark', width: 375, height: 812, theme: 'dark' },
  { name: 'mobile-375-light', width: 375, height: 812, theme: 'light' },
];

const browser = await chromium.launch({ headless: true });
const failures = [];

try {
  for (const item of cases) {
    const context = await browser.newContext({
      viewport: { width: item.width, height: item.height },
      colorScheme: item.theme,
      serviceWorkers: 'block',
    });
    await context.addInitScript((theme) => localStorage.setItem('iq-theme', theme), item.theme);

    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (!response || !response.ok()) {
        throw new Error(`HTTP response was ${response?.status() ?? 'missing'}`);
      }

      await page.getByRole('heading', { name: 'Masuk' }).waitFor({ state: 'visible', timeout: 30_000 });
      await page.getByLabel('Email').waitFor({ state: 'visible' });
      await page.getByLabel('Password').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Masuk' }).waitFor({ state: 'visible' });

      const rendered = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        dark: document.documentElement.classList.contains('dark'),
        themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
        title: document.title,
      }));

      if (rendered.documentWidth > rendered.viewportWidth + 1 || rendered.bodyWidth > rendered.viewportWidth + 1) {
        throw new Error(`Horizontal overflow: viewport=${rendered.viewportWidth}, document=${rendered.documentWidth}, body=${rendered.bodyWidth}`);
      }
      if (rendered.dark !== (item.theme === 'dark')) {
        throw new Error(`Theme mismatch: expected ${item.theme}, html.dark=${rendered.dark}`);
      }
      const expectedColor = item.theme === 'dark' ? '#020617' : '#f8fafc';
      if (rendered.themeColor !== expectedColor) {
        throw new Error(`theme-color mismatch: expected ${expectedColor}, received ${rendered.themeColor}`);
      }
      if (consoleErrors.length || pageErrors.length) {
        throw new Error([
          ...consoleErrors.map((x) => `console.error: ${x}`),
          ...pageErrors.map((x) => `pageerror: ${x}`),
        ].join('\n'));
      }

      await page.screenshot({ path: resolve(outputDir, `${item.name}.png`), fullPage: true });
      console.log(`PASS ${item.name}: ${rendered.viewportWidth}px, ${item.theme}, title="${rendered.title}"`);
    } catch (error) {
      failures.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
      await page.screenshot({ path: resolve(outputDir, `${item.name}-failure.png`), fullPage: true }).catch(() => {});
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('Live public UI smoke failures:\n' + failures.join('\n\n'));
  process.exitCode = 1;
} else {
  console.log(`All ${cases.length} public login browser checks passed for ${baseUrl}`);
}
