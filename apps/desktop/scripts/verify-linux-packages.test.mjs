import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  findPackages,
  verifyFileList,
} = require('./verify-linux-packages.cjs');

const desktopDir = fileURLToPath(new URL('..', import.meta.url));

async function readDesktopPackageJson() {
  return JSON.parse(await readFile(join(desktopDir, 'package.json'), 'utf-8'));
}

describe('linux package verifier', () => {
  test('finds all expected Linux package targets in dist', async () => {
    const distDir = await mkdtemp(join(tmpdir(), 'autocode-linux-dist-'));
    try {
      await writeFile(join(distDir, 'Autocode-1.0.0-linux-x64.AppImage'), 'appimage');
      await writeFile(join(distDir, 'autocode_1.0.0_amd64.deb'), 'deb');
      await writeFile(join(distDir, 'Autocode-1.0.0.flatpak'), 'flatpak');

      const packages = findPackages(distDir);

      assert.equal(packages.appImage, join(distDir, 'Autocode-1.0.0-linux-x64.AppImage'));
      assert.equal(packages.deb, join(distDir, 'autocode_1.0.0_amd64.deb'));
      assert.equal(packages.flatpak, join(distDir, 'Autocode-1.0.0.flatpak'));
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });

  test('requires bundled app.asar rather than only app.asar.unpacked', () => {
    assert.equal(
      verifyFileList([
        '/opt/Autocode/resources/app.asar',
        '/opt/Autocode/resources/app.asar.unpacked/native.node',
      ], 'AppImage').verified,
      true,
    );

    const missing = verifyFileList([
      '/opt/Autocode/resources/app.asar.unpacked/native.node',
    ], 'AppImage');
    assert.equal(missing.verified, false);
    assert.match(missing.issues.join('\n'), /app\.asar not found/);
  });
});

describe('electron builder release resources', () => {
  test('bundles prompts and native module resources required at runtime', async () => {
    const pkg = await readDesktopPackageJson();
    const build = pkg.build;
    const extraResources = build.extraResources.map((entry) => `${entry.from}->${entry.to}`);

    assert.deepEqual(build.files, ['out/**/*', 'package.json']);
    assert.ok(build.asarUnpack.some((entry) => entry.includes('@lydell/node-pty')));
    assert.ok(extraResources.includes('resources/icon.ico->icon.ico'));
    assert.ok(extraResources.includes('prompts->prompts'));
    assert.ok(extraResources.includes('../../node_modules/@libsql->node_modules/@libsql'));
    assert.ok(extraResources.includes('../../node_modules/libsql->node_modules/libsql'));
    assert.ok(extraResources.includes('../../node_modules/@neon-rs->node_modules/@neon-rs'));
    assert.ok(extraResources.includes('../../node_modules/detect-libc->node_modules/detect-libc'));
    assert.ok(extraResources.includes('../../node_modules/@lydell/node-pty->node_modules/@lydell/node-pty'));
    assert.ok(extraResources.includes('../../node_modules/@lydell/node-pty-win32-x64->node_modules/@lydell/node-pty-win32-x64'));

    for (const prompt of ['planner.md', 'coder.md', 'qa_reviewer.md']) {
      assert.equal(existsSync(join(desktopDir, 'prompts', prompt)), true, `${prompt} should exist`);
    }
  });

  test('keeps Windows NSIS installer icon and shortcut configuration wired', async () => {
    const pkg = await readDesktopPackageJson();
    const installer = await readFile(join(desktopDir, 'resources', 'installer.nsh'), 'utf-8');

    assert.equal(pkg.build.win.icon, 'resources/icon.ico');
    assert.deepEqual(pkg.build.win.target, ['nsis', 'zip']);
    assert.equal(pkg.build.nsis.include, 'installer.nsh');
    assert.equal(pkg.build.nsis.shortcutName, 'Autocode');
    assert.equal(pkg.build.nsis.createDesktopShortcut, 'always');
    assert.equal(pkg.build.nsis.createStartMenuShortcut, true);
    assert.match(installer, /!macro customInstall/);
    assert.match(installer, /resources\\icon\.ico/);
    assert.match(installer, /CreateShortCut/);
    assert.match(installer, /WinShell::SetLnkAUMI/);
  });
});
