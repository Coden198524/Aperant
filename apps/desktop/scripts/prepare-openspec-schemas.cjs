const { createHash } = require('node:crypto');
const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const OPEN_SPEC_PACKAGE = '@fission-ai/openspec';
const OPEN_SPEC_VERSION = '1.6.0';
const SCHEMA_NAME = 'spec-driven-with-adr';
const SCHEMA_REPOSITORY = 'https://github.com/intent-driven-dev/openspec-schemas';
const SCHEMA_COMMIT = '87ec4decf3151b0d7d10b7bf0f6ad9c7e74eccc0';
const SCHEMA_LICENSE = 'MIT';
const SCHEMA_SOURCE_PATH = 'openspec/schemas/spec-driven-with-adr';
const SCHEMA_MINIMUM_OPEN_SPEC_VERSION = '1.0.0';
const PROVENANCE_FILE_NAME = 'openspec-schemas.provenance.json';
const LICENSE_FILE_NAME = 'openspec-schemas.LICENSE';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const EXPECTED_LICENSE = Object.freeze({
  byteLength: 1056,
  sha256: '1126322e2cc8d165adc4c792eeb195717de2bcc7b39be1ce77959d78e87ef685',
});

const EXPECTED_SCHEMA_FILES = Object.freeze([
  Object.freeze({
    path: 'README.md',
    byteLength: 2505,
    sha256: '2e4bfb47877c9bf0a25f34c7ac596abebdb77c3caef52168394393a0ae0dad20',
  }),
  Object.freeze({
    path: 'schema.yaml',
    byteLength: 11537,
    sha256: 'eae18d55e431fdd707a042e869c0ed89686f43d6b180723015e97ce34a97c272',
  }),
  Object.freeze({
    path: 'templates/adr.md',
    byteLength: 818,
    sha256: '121d39dccc6bad2b210e990bacad3825284ecf2a63037439452932536c9b03db',
  }),
  Object.freeze({
    path: 'templates/design.md',
    byteLength: 302,
    sha256: '3251f08057d142f6e3c26f65f5f100ab602ee7ce880d5503bfaa45668ba19f59',
  }),
  Object.freeze({
    path: 'templates/proposal.md',
    byteLength: 888,
    sha256: '9c554e0dbe918e3dc745dcc143a999e1d102954d75fb6e51e231c4cba78f06f3',
  }),
  Object.freeze({
    path: 'templates/spec.md',
    byteLength: 198,
    sha256: 'e025078f238dc6e4df552a1e0a140cf9efce0bbdecbeb9f45837d45ed91dca01',
  }),
  Object.freeze({
    path: 'templates/tasks.md',
    byteLength: 209,
    sha256: 'b2a6a4c08c15f347a1d8c3e2d43e0c8fb066dc5cc0feb795f47555f176f9c421',
  }),
]);

function cloneSchemaFiles() {
  return EXPECTED_SCHEMA_FILES.map((entry) => ({ ...entry }));
}

function expectedProvenanceManifest() {
  return {
    formatVersion: 1,
    repository: SCHEMA_REPOSITORY,
    commit: SCHEMA_COMMIT,
    license: SCHEMA_LICENSE,
    licenseFile: 'LICENSE',
    licenseByteLength: EXPECTED_LICENSE.byteLength,
    licenseSha256: EXPECTED_LICENSE.sha256,
    schemas: [
      {
        name: SCHEMA_NAME,
        sourcePath: SCHEMA_SOURCE_PATH,
        minimumOpenSpecVersion: SCHEMA_MINIMUM_OPEN_SPEC_VERSION,
        files: cloneSchemaFiles(),
      },
    ],
  };
}

function expectedBundledSchema() {
  const relativeRoot = `schemas/${SCHEMA_NAME}`;
  return {
    name: SCHEMA_NAME,
    repository: SCHEMA_REPOSITORY,
    commit: SCHEMA_COMMIT,
    license: SCHEMA_LICENSE,
    sourcePath: SCHEMA_SOURCE_PATH,
    minimumOpenSpecVersion: SCHEMA_MINIMUM_OPEN_SPEC_VERSION,
    relativeRoot,
    provenanceFile: `${relativeRoot}/${PROVENANCE_FILE_NAME}`,
    licenseFile: `${relativeRoot}/${LICENSE_FILE_NAME}`,
    licenseByteLength: EXPECTED_LICENSE.byteLength,
    licenseSha256: EXPECTED_LICENSE.sha256,
    files: cloneSchemaFiles(),
  };
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${label} JSON at ${filePath}: ${error.message}`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (!isDeepStrictEqual(actualKeys, sortedExpectedKeys)) {
    throw new Error(`${label} contains an unexpected field set.`);
  }
}

function assertSafeRelativePath(relativePath, label) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} is not a safe normalized relative path: ${String(relativePath)}`);
  }
  return relativePath;
}

function resolveInside(root, relativePath, label) {
  assertSafeRelativePath(relativePath, label);
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...relativePath.split('/'));
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} resolves outside its expected root.`);
  }
  return resolvedPath;
}

function assertRegularFile(filePath, label) {
  if (!existsSync(filePath) || !lstatSync(filePath).isFile()) {
    throw new Error(`${label} is missing or is not a regular file: ${filePath}`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertPinnedBytes(filePath, expected, label) {
  assertRegularFile(filePath, label);
  if (
    !Number.isSafeInteger(expected.byteLength) ||
    expected.byteLength <= 0 ||
    typeof expected.sha256 !== 'string' ||
    !SHA256_PATTERN.test(expected.sha256)
  ) {
    throw new Error(`${label} has an invalid pinned digest baseline.`);
  }
  const bytes = readFileSync(filePath);
  if (bytes.includes(0x0d)) {
    throw new Error(`${label} must preserve the reviewed LF-only upstream bytes.`);
  }
  const digest = sha256(bytes);
  if (bytes.byteLength !== expected.byteLength || digest !== expected.sha256) {
    throw new Error(
      `${label} does not match the reviewed upstream bytes ` +
        `(expected ${expected.byteLength}/${expected.sha256}, found ${bytes.byteLength}/${digest}).`,
    );
  }
  return bytes;
}

function listRelativeFiles(root) {
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot) || !lstatSync(resolvedRoot).isDirectory()) {
    throw new Error(`OpenSpec Schema bundle directory is missing: ${resolvedRoot}`);
  }
  const files = [];
  const visit = (directory, relativeDirectory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      assertSafeRelativePath(relativePath, 'Bundled Schema file');
      const absolutePath = resolveInside(resolvedRoot, relativePath, 'Bundled Schema file');
      if (entry.isSymbolicLink()) {
        throw new Error(`Bundled Schema paths must not be symbolic links: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`Bundled Schema path has an unsupported file type: ${absolutePath}`);
      }
    }
  };
  visit(resolvedRoot, '');
  return files.sort();
}

function assertProvenanceManifest(manifest, label) {
  const expected = expectedProvenanceManifest();
  assertExactKeys(manifest, Object.keys(expected), label);
  if (!Array.isArray(manifest.schemas) || manifest.schemas.length !== 1) {
    throw new Error(`${label} must contain exactly one reviewed Schema.`);
  }
  assertExactKeys(
    manifest.schemas[0],
    Object.keys(expected.schemas[0]),
    `${label} Schema entry`,
  );
  if (
    !Array.isArray(manifest.schemas[0].files) ||
    manifest.schemas[0].files.length !== EXPECTED_SCHEMA_FILES.length
  ) {
    throw new Error(`${label} has an incomplete Schema file list.`);
  }
  for (const [index, file] of manifest.schemas[0].files.entries()) {
    assertExactKeys(
      file,
      ['path', 'byteLength', 'sha256'],
      `${label} Schema file entry ${index}`,
    );
    assertSafeRelativePath(file.path, `${label} Schema file entry ${index}`);
  }
  if (!isDeepStrictEqual(manifest, expected)) {
    throw new Error(`${label} does not match the reviewed Schema supply-chain baseline.`);
  }
  return manifest;
}

function validateVendoredSchemaBundle(vendorRoot) {
  const resolvedVendorRoot = path.resolve(vendorRoot);
  const manifestPath = path.join(resolvedVendorRoot, 'manifest.json');
  const licensePath = path.join(resolvedVendorRoot, 'LICENSE');
  assertRegularFile(manifestPath, 'OpenSpec Schema provenance manifest');
  const manifestBytes = readFileSync(manifestPath);
  if (manifestBytes.includes(0x0d)) {
    throw new Error('OpenSpec Schema provenance manifest must use LF-only bytes.');
  }
  const manifest = assertProvenanceManifest(
    readJson(manifestPath, 'OpenSpec Schema provenance manifest'),
    'OpenSpec Schema provenance manifest',
  );
  assertPinnedBytes(licensePath, EXPECTED_LICENSE, 'OpenSpec Schema upstream license');

  const schemaRoot = path.join(resolvedVendorRoot, SCHEMA_NAME);
  for (const file of EXPECTED_SCHEMA_FILES) {
    const sourcePath = resolveInside(
      schemaRoot,
      file.path,
      `OpenSpec Schema source file "${file.path}"`,
    );
    assertPinnedBytes(sourcePath, file, `OpenSpec Schema source file "${file.path}"`);
  }

  const expectedFiles = [
    'LICENSE',
    'manifest.json',
    ...EXPECTED_SCHEMA_FILES.map((entry) => `${SCHEMA_NAME}/${entry.path}`),
  ].sort();
  const actualFiles = listRelativeFiles(resolvedVendorRoot);
  if (!isDeepStrictEqual(actualFiles, expectedFiles)) {
    throw new Error('OpenSpec Schema vendor bundle contains missing or unreviewed files.');
  }

  return {
    vendorRoot: resolvedVendorRoot,
    schemaRoot,
    manifestPath,
    licensePath,
    manifest,
    bundledSchemas: [expectedBundledSchema()],
  };
}

function findOpenSpecPackageRoot(fromDirectory) {
  let entryPath;
  try {
    entryPath = require.resolve(OPEN_SPEC_PACKAGE, { paths: [fromDirectory] });
  } catch (error) {
    throw new Error(
      `Unable to resolve ${OPEN_SPEC_PACKAGE}@${OPEN_SPEC_VERSION} from ${fromDirectory}: ` +
        error.message,
    );
  }
  let cursor = path.dirname(entryPath);
  while (path.dirname(cursor) !== cursor) {
    const packageJsonPath = path.join(cursor, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = readJson(packageJsonPath, OPEN_SPEC_PACKAGE);
      if (packageJson.name === OPEN_SPEC_PACKAGE) {
        return cursor;
      }
    }
    cursor = path.dirname(cursor);
  }
  throw new Error(`Resolved ${OPEN_SPEC_PACKAGE} but could not locate its package root.`);
}

function validateTargetPackage(packageRoot) {
  const resolvedPackageRoot = path.resolve(packageRoot);
  const packageJsonPath = path.join(resolvedPackageRoot, 'package.json');
  assertRegularFile(packageJsonPath, `${OPEN_SPEC_PACKAGE} package.json`);
  const packageJson = readJson(packageJsonPath, OPEN_SPEC_PACKAGE);
  if (
    packageJson.name !== OPEN_SPEC_PACKAGE ||
    packageJson.version !== OPEN_SPEC_VERSION ||
    packageJson.license !== 'MIT'
  ) {
    throw new Error(
      `Expected ${OPEN_SPEC_PACKAGE}@${OPEN_SPEC_VERSION} with an MIT license at ` +
        `${resolvedPackageRoot}, found ${String(packageJson.name)}@${String(packageJson.version)} ` +
        `(${String(packageJson.license)}).`,
    );
  }
  const builtInSchema = path.join(resolvedPackageRoot, 'schemas', 'spec-driven', 'schema.yaml');
  assertRegularFile(builtInSchema, `${OPEN_SPEC_PACKAGE} built-in spec-driven Schema`);
  return { packageRoot: resolvedPackageRoot, packageJson };
}

function assertBundledSchemaManifest(bundledSchemas) {
  const expected = [expectedBundledSchema()];
  if (!isDeepStrictEqual(bundledSchemas, expected)) {
    throw new Error('Bundled OpenSpec Schema manifest does not match the reviewed baseline.');
  }
  return bundledSchemas;
}

function verifySchemaDirectory(schemaRoot, bundledSchema) {
  const expectedFiles = [
    ...bundledSchema.files.map((entry) => entry.path),
    PROVENANCE_FILE_NAME,
    LICENSE_FILE_NAME,
  ].sort();
  const actualFiles = listRelativeFiles(schemaRoot);
  if (!isDeepStrictEqual(actualFiles, expectedFiles)) {
    throw new Error(`Installed OpenSpec Schema "${SCHEMA_NAME}" contains unexpected files.`);
  }

  for (const file of bundledSchema.files) {
    const installedPath = resolveInside(
      schemaRoot,
      file.path,
      `Installed OpenSpec Schema file "${file.path}"`,
    );
    assertPinnedBytes(installedPath, file, `Installed OpenSpec Schema file "${file.path}"`);
  }

  const provenancePath = resolveInside(
    schemaRoot,
    PROVENANCE_FILE_NAME,
    'Installed OpenSpec Schema provenance manifest',
  );
  assertRegularFile(provenancePath, 'Installed OpenSpec Schema provenance manifest');
  const provenanceBytes = readFileSync(provenancePath);
  if (provenanceBytes.includes(0x0d)) {
    throw new Error('Installed OpenSpec Schema provenance manifest must use LF-only bytes.');
  }
  assertProvenanceManifest(
    readJson(provenancePath, 'installed OpenSpec Schema provenance manifest'),
    'Installed OpenSpec Schema provenance manifest',
  );

  const licensePath = resolveInside(
    schemaRoot,
    LICENSE_FILE_NAME,
    'Installed OpenSpec Schema upstream license',
  );
  assertPinnedBytes(licensePath, EXPECTED_LICENSE, 'Installed OpenSpec Schema upstream license');
}

function verifyBundledSchemas(packageRoot, bundledSchemas = [expectedBundledSchema()]) {
  const target = validateTargetPackage(packageRoot);
  assertBundledSchemaManifest(bundledSchemas);
  for (const bundledSchema of bundledSchemas) {
    assertSafeRelativePath(bundledSchema.relativeRoot, 'Bundled OpenSpec Schema root');
    assertSafeRelativePath(
      bundledSchema.provenanceFile,
      'Bundled OpenSpec Schema provenance path',
    );
    assertSafeRelativePath(bundledSchema.licenseFile, 'Bundled OpenSpec Schema license path');
    for (const file of bundledSchema.files) {
      assertSafeRelativePath(file.path, 'Bundled OpenSpec Schema file path');
    }
    const schemaRoot = resolveInside(
      target.packageRoot,
      bundledSchema.relativeRoot,
      'Bundled OpenSpec Schema root',
    );
    verifySchemaDirectory(schemaRoot, bundledSchema);
  }
  return {
    packageRoot: target.packageRoot,
    bundledSchemas,
  };
}

function prepareOpenSpecSchemas(packageRoot, options = {}) {
  const desktopRoot = path.resolve(__dirname, '..');
  const vendorRoot = options.vendorRoot
    ? path.resolve(options.vendorRoot)
    : path.join(desktopRoot, 'resources', 'openspec-schemas');
  const source = validateVendoredSchemaBundle(vendorRoot);
  const resolvedPackageRoot = packageRoot
    ? path.resolve(packageRoot)
    : findOpenSpecPackageRoot(desktopRoot);
  const target = validateTargetPackage(resolvedPackageRoot);
  const bundledSchemas = source.bundledSchemas;

  try {
    verifyBundledSchemas(target.packageRoot, bundledSchemas);
    return {
      packageRoot: target.packageRoot,
      bundledSchemas,
      changed: false,
    };
  } catch {
    // A missing or drifted injected Schema is replaced from the reviewed vendor bytes below.
  }

  const schemasRoot = path.join(target.packageRoot, 'schemas');
  mkdirSync(schemasRoot, { recursive: true });
  const destinationRoot = resolveInside(
    target.packageRoot,
    `schemas/${SCHEMA_NAME}`,
    'OpenSpec Schema injection target',
  );
  const temporaryRelativeRoot =
    `schemas/.${SCHEMA_NAME}.aperant-${process.pid}-${Date.now()}`;
  const temporaryRoot = resolveInside(
    target.packageRoot,
    temporaryRelativeRoot,
    'OpenSpec Schema temporary injection target',
  );

  if (existsSync(temporaryRoot)) {
    throw new Error(`Refusing to reuse an existing OpenSpec Schema staging path: ${temporaryRoot}`);
  }
  mkdirSync(temporaryRoot, { recursive: true });
  try {
    for (const file of EXPECTED_SCHEMA_FILES) {
      const sourcePath = resolveInside(
        source.schemaRoot,
        file.path,
        `OpenSpec Schema source file "${file.path}"`,
      );
      const destinationPath = resolveInside(
        temporaryRoot,
        file.path,
        `OpenSpec Schema target file "${file.path}"`,
      );
      mkdirSync(path.dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
    }
    copyFileSync(
      source.manifestPath,
      path.join(temporaryRoot, PROVENANCE_FILE_NAME),
    );
    copyFileSync(source.licensePath, path.join(temporaryRoot, LICENSE_FILE_NAME));
    verifySchemaDirectory(temporaryRoot, bundledSchemas[0]);

    if (existsSync(destinationRoot)) {
      rmSync(destinationRoot, { recursive: true, force: true });
    }
    renameSync(temporaryRoot, destinationRoot);
  } finally {
    if (existsSync(temporaryRoot)) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  verifyBundledSchemas(target.packageRoot, bundledSchemas);
  return {
    packageRoot: target.packageRoot,
    bundledSchemas,
    changed: true,
  };
}

module.exports = {
  OPEN_SPEC_PACKAGE,
  OPEN_SPEC_VERSION,
  SCHEMA_NAME,
  SCHEMA_REPOSITORY,
  SCHEMA_COMMIT,
  SCHEMA_LICENSE,
  EXPECTED_SCHEMA_FILES,
  expectedBundledSchema,
  prepareOpenSpecSchemas,
  validateVendoredSchemaBundle,
  verifyBundledSchemas,
  __testUtils: {
    assertSafeRelativePath,
    expectedProvenanceManifest,
    findOpenSpecPackageRoot,
  },
};

if (require.main === module) {
  try {
    const result = prepareOpenSpecSchemas(process.argv[2]);
    console.log(
      `[prepare-openspec-schemas] ${result.changed ? 'Injected' : 'Verified'} ` +
        `${SCHEMA_NAME} from ${SCHEMA_COMMIT} in ${result.packageRoot}.`,
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
