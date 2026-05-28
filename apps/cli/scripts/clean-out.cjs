const { rmSync } = require('node:fs');
const { resolve, sep } = require('node:path');

const packageRoot = resolve(__dirname, '..');
const outPath = resolve(packageRoot, 'out');

if (!outPath.startsWith(`${packageRoot}${sep}`)) {
  throw new Error(`Refusing to clean path outside package root: ${outPath}`);
}

rmSync(outPath, { recursive: true, force: true });
