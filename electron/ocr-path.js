// Locate the native OCR helper (mao-ocr).
const path = require('path');
const fs = require('fs');

function relPathFor(platform, arch) {
  if (platform === 'darwin') {
    const dir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    return path.join('resources', 'bin', dir, 'mao-ocr');
  }
  return null;
}

function resolveOcrPath({
  platform = process.platform,
  arch = process.arch,
  resourcesPath = process.resourcesPath,
  appPath = path.join(__dirname, '..'),
  existsSync = fs.existsSync,
} = {}) {
  const rel = relPathFor(platform, arch);
  if (!rel) return null;

  const candidates = [
    resourcesPath ? path.join(resourcesPath, rel) : null,
    path.join(appPath, rel),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Ignored
    }
  }
  return null;
}

module.exports = { resolveOcrPath, relPathFor };
