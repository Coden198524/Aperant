const { existsSync, readdirSync, statSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');

const packageRoot = resolve(__dirname, '..');
const srcDir = join(packageRoot, 'src');
const distIndex = join(packageRoot, 'dist', 'index.js');
const distTypes = join(packageRoot, 'dist', 'index.d.ts');

function newestMtime(path) {
  if (!existsSync(path)) {
    return 0;
  }

  const stat = statSync(path);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  return readdirSync(path)
    .map((entry) => newestMtime(join(path, entry)))
    .reduce((max, mtime) => Math.max(max, mtime), stat.mtimeMs);
}

const distReady = existsSync(distIndex) && existsSync(distTypes);
const sourceMtime = Math.max(
  newestMtime(srcDir),
  newestMtime(join(packageRoot, 'tsconfig.json')),
  newestMtime(join(packageRoot, 'tsconfig.build.json')),
);
const distMtime = Math.min(newestMtime(distIndex), newestMtime(distTypes));

if (distReady && distMtime >= sourceMtime) {
  process.exit(0);
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['run', 'build'], {
  cwd: packageRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
