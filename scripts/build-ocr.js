#!/usr/bin/env node
/**
 * Build the native OCR helper (mao-ocr) for macOS.
 *
 * The binary is produced here and placed in resources/bin/<platform>/
 * for packaging with extraResources.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

if (process.platform !== 'darwin') {
  console.log('[build:ocr] OCR native helper currently only needed on macOS; skipping.');
  process.exit(0);
}

const job = {
  cmd: 'bash',
  args: [path.join(root, 'native', 'ocr', 'mac', 'build.sh')],
  shell: false,
};

const r = spawnSync(job.cmd, job.args, { stdio: 'inherit', shell: job.shell });
if (r.error) {
  console.error(`[build:ocr] Failed to run the build: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 0);
