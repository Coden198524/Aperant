import assert from 'node:assert/strict';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  SCHEMA_NAME,
  __testUtils,
  prepareOpenSpecSchemas,
  verifyBundledSchemas,
} = require('./prepare-openspec-schemas.cjs');

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptsRoot, '..');
const vendorRoot = path.join(desktopRoot, 'resources', 'openspec-schemas');
const temporaryRoots = [];

function temporaryRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'aperant-openspec-schema-test-'));
  temporaryRoots.push(root);
  return root;
}

function createOpenSpecPackage(root, version = '1.6.0') {
  const packageRoot = path.join(root, 'openspec-package');
  mkdirSync(path.join(packageRoot, 'schemas', 'spec-driven'), { recursive: true });
  writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({
      name: '@fission-ai/openspec',
      version,
      license: 'MIT',
    }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(packageRoot, 'schemas', 'spec-driven', 'schema.yaml'),
    'name: spec-driven\nversion: 1\nartifacts: []\n',
    'utf8',
  );
  return packageRoot;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('injects and re-verifies the reviewed ADR Schema bytes idempotently', () => {
  const packageRoot = createOpenSpecPackage(temporaryRoot());
  const first = prepareOpenSpecSchemas(packageRoot);
  assert.equal(first.changed, true);
  assert.equal(first.bundledSchemas[0].name, SCHEMA_NAME);

  const sourceSchema = readFileSync(
    path.join(vendorRoot, SCHEMA_NAME, 'schema.yaml'),
  );
  const targetSchemaPath = path.join(
    packageRoot,
    'schemas',
    SCHEMA_NAME,
    'schema.yaml',
  );
  assert.deepEqual(readFileSync(targetSchemaPath), sourceSchema);
  assert.doesNotThrow(() =>
    verifyBundledSchemas(packageRoot, first.bundledSchemas),
  );

  const second = prepareOpenSpecSchemas(packageRoot);
  assert.equal(second.changed, false);

  appendFileSync(targetSchemaPath, '\r\nunreviewed: true\r\n', 'utf8');
  assert.throws(
    () => verifyBundledSchemas(packageRoot, first.bundledSchemas),
    /reviewed LF-only upstream bytes/,
  );
  const repaired = prepareOpenSpecSchemas(packageRoot);
  assert.equal(repaired.changed, true);
  assert.deepEqual(readFileSync(targetSchemaPath), sourceSchema);
});

test('rejects vendor byte drift, unsafe paths, and target package version drift', () => {
  const root = temporaryRoot();
  const copiedVendorRoot = path.join(root, 'vendor');
  cpSync(vendorRoot, copiedVendorRoot, { recursive: true });
  appendFileSync(
    path.join(copiedVendorRoot, SCHEMA_NAME, 'README.md'),
    '\r\n',
    'utf8',
  );
  const packageRoot = createOpenSpecPackage(root);
  assert.throws(
    () => prepareOpenSpecSchemas(packageRoot, { vendorRoot: copiedVendorRoot }),
    /LF-only upstream bytes/,
  );

  assert.throws(
    () => __testUtils.assertSafeRelativePath('../escape.md', 'test path'),
    /safe normalized relative path/,
  );
  assert.throws(
    () => prepareOpenSpecSchemas(createOpenSpecPackage(temporaryRoot(), '1.6.1')),
    /Expected @fission-ai\/openspec@1\.6\.0/,
  );
});
