const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative, resolve } = require('node:path');

const packageRoot = resolve(__dirname, '..');
const srcRoot = join(packageRoot, 'src');

const bannedPatterns = [
  { pattern: /\bfrom\s+['"]electron['"]/, message: 'Electron imports belong in frontend adapters.' },
  { pattern: /\bimport\s*\(\s*['"]electron['"]\s*\)/, message: 'Dynamic Electron imports belong in frontend adapters.' },
  { pattern: /@lydell\/node-pty/, message: 'PTY management belongs in desktop or host adapters.' },
  { pattern: /\bipcMain\b/, message: 'IPC registration belongs in desktop.' },
  { pattern: /\bBrowserWindow\b/, message: 'Window references belong in desktop.' },
  { pattern: /\bsafeStorage\b/, message: 'OS keychain access belongs in frontend adapters.' },
  { pattern: /\bwebContents\b/, message: 'Renderer communication belongs in desktop.' },
];

function listSourceFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      return listSourceFiles(fullPath);
    }
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry) ? [fullPath] : [];
  });
}

const violations = [];
for (const filePath of listSourceFiles(srcRoot)) {
  const content = readFileSync(filePath, 'utf8');
  for (const banned of bannedPatterns) {
    if (banned.pattern.test(content)) {
      violations.push({
        filePath: relative(packageRoot, filePath),
        message: banned.message,
      });
    }
  }
}

if (violations.length > 0) {
  console.error('@autocode/core boundary check failed:');
  for (const violation of violations) {
    console.error(`- ${violation.filePath}: ${violation.message}`);
  }
  process.exit(1);
}
