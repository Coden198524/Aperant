const { rmSync } = require('node:fs');
const { resolve, sep } = require('node:path');

const packageRoot = resolve(__dirname, '..');
const distPath = resolve(packageRoot, 'dist');

if (!distPath.startsWith(`${packageRoot}${sep}`)) {
  throw new Error(`Refusing to clean path outside package root: ${distPath}`);
}

rmSync(distPath, { recursive: true, force: true });
