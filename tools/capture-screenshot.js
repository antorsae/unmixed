#!/usr/bin/env node
"use strict";

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const HOST = '127.0.0.1';
const PORT = process.env.SCREENSHOT_PORT || 4173;
const BASE_URL = `http://${HOST}:${PORT}`;
const ZIP_ARG = process.argv[2] || 'test-data/mozart_mp3.zip';
const OUTPUT_ARG = process.argv[3] || 'docs/screenshot.png';
const VIEWPORT = { width: 1440, height: 900 };

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return;
    } catch (_) {
      // Keep polling.
    }
    await sleep(300);
  }
  throw new Error(`Server did not respond within ${timeoutMs}ms: ${url}`);
}

async function main() {
  const zipPath = path.resolve(ZIP_ARG);
  const outputPath = path.resolve(OUTPUT_ARG);

  if (!fs.existsSync(zipPath)) {
    throw new Error(`ZIP file not found: ${zipPath}`);
  }

  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', HOST], {
    stdio: 'inherit',
  });

  try {
    await waitForServer(`${BASE_URL}/index.html`);

    const browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });

    try {
      const context = await browser.newContext({ viewport: VIEWPORT });
      const page = await context.newPage();

      await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'networkidle' });

      await page.addStyleTag({
        content: '* { animation: none !important; transition: none !important; }',
      });

      await page.setInputFiles('#zip-input', zipPath);

      await page.waitForFunction(() => {
        const el = document.querySelector('#track-count');
        if (!el) return false;
        const match = el.textContent.match(/\((\d+)\)/);
        return match && parseInt(match[1], 10) >= 10;
      }, { timeout: 120000 });

      await page.waitForFunction(() => {
        const progress = document.querySelector('#load-progress');
        return progress && progress.classList.contains('hidden');
      }, { timeout: 120000 });

      await page.waitForTimeout(500);

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const target = await page.$('#main-content');
      if (!target) {
        throw new Error('Main content container not found for screenshot.');
      }
      await target.screenshot({ path: outputPath });
    } finally {
      await browser.close();
    }
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
