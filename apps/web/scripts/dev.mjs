import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const children = new Set();

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: isWindows,
    ...options,
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function stopAll() {
  for (const child of children) {
    child.kill('SIGTERM');
  }
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});

const build = run('npm', ['run', 'build:server']);
build.on('exit', (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }

  run('node', ['dist/server/index.js']);
  run('npm', ['run', 'dev:client']);
});
