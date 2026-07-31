const {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  SCHEMA_COMMIT,
  SCHEMA_NAME,
  SCHEMA_REPOSITORY,
  prepareOpenSpecSchemas,
} = require('./prepare-openspec-schemas.cjs');

const OPEN_SPEC_VERSION = '1.6.0';
const OPEN_SPEC_TARBALL_SHA1 = '00b6f63e9671153b8621466a9ed423792349b54f';
const OPEN_SPEC_TARBALL_URL =
  'https://registry.npmjs.org/@fission-ai/openspec/-/openspec-1.6.0.tgz';
const OPEN_SPEC_LOCK_INTEGRITY =
  'sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==';
const OPEN_SPEC_PROMPT_FACTORIES = {
  explore: 'getOpsxExploreCommandTemplate',
  propose: 'getOpsxProposeCommandTemplate',
  apply: 'getOpsxApplyCommandTemplate',
  update: 'getOpsxUpdateCommandTemplate',
  sync: 'getOpsxSyncCommandTemplate',
  archive: 'getOpsxArchiveCommandTemplate',
  new: 'getOpsxNewCommandTemplate',
  continue: 'getOpsxContinueCommandTemplate',
  ff: 'getOpsxFfCommandTemplate',
  verify: 'getOpsxVerifyCommandTemplate',
  'bulk-archive': 'getOpsxBulkArchiveCommandTemplate',
  onboard: 'getOpsxOnboardCommandTemplate',
};

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function findPackage(name, fromDirectory) {
  let entryPath;
  try {
    entryPath = require.resolve(name, { paths: [fromDirectory] });
  } catch (error) {
    throw new Error(`Unable to resolve OpenSpec runtime dependency "${name}" from ${fromDirectory}: ${error.message}`);
  }

  let cursor = path.dirname(entryPath);
  while (path.dirname(cursor) !== cursor) {
    const packageJsonPath = path.join(cursor, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = readJson(packageJsonPath);
      if (packageJson.name === name) {
        return { root: cursor, packageJsonPath, packageJson };
      }
    }
    cursor = path.dirname(cursor);
  }
  throw new Error(`Resolved "${name}" but could not locate its package root.`);
}

function collectDependencyClosure(rootPackageName, workspaceRoot) {
  const packages = new Map();
  const visit = (name, fromDirectory) => {
    const resolved = findPackage(name, fromDirectory);
    if (packages.has(resolved.root)) return;
    packages.set(resolved.root, resolved);
    for (const dependency of Object.keys(resolved.packageJson.dependencies || {})) {
      visit(dependency, resolved.root);
    }
  };
  visit(rootPackageName, workspaceRoot);
  return [...packages.values()];
}

function licenseText(packageInfo) {
  for (const name of [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'LICENCE',
    'LICENCE.md',
    'LICENCE.txt',
  ]) {
    const candidate = path.join(packageInfo.root, name);
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf8').trim();
    }
  }
  return `License identifier: ${packageInfo.packageJson.license || 'UNKNOWN'}`;
}

function assertSafeStagingPath(stagingRoot, desktopRoot) {
  const resolvedStaging = path.resolve(stagingRoot);
  const resolvedDesktop = path.resolve(desktopRoot);
  const relative = path.relative(resolvedDesktop, resolvedStaging);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative !== path.join('out', 'openspec-runtime')
  ) {
    throw new Error(`Refusing to replace unexpected OpenSpec staging path: ${resolvedStaging}`);
  }
}

async function promptManifest(openSpecRoot) {
  const relativeSource = 'dist/core/templates/skill-templates.js';
  const sourcePath = path.join(openSpecRoot, ...relativeSource.split('/'));
  if (!existsSync(sourcePath)) {
    throw new Error(`OpenSpec workflow prompt module is missing: ${sourcePath}`);
  }
  const module = await import(pathToFileURL(sourcePath).href);
  return Object.entries(OPEN_SPEC_PROMPT_FACTORIES).map(([action, factoryName]) => {
    const factory = module[factoryName];
    if (typeof factory !== 'function') {
      throw new Error(`OpenSpec workflow prompt factory is missing: ${factoryName}`);
    }
    const prompt = factory()?.content;
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new Error(`OpenSpec workflow prompt is empty: ${factoryName}`);
    }
    const bytes = Buffer.from(prompt, 'utf8');
    return {
      action,
      factory: factoryName,
      source: relativeSource,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

async function prepareOpenSpecRuntime() {
  const desktopRoot = path.resolve(__dirname, '..');
  const workspaceRoot = path.resolve(desktopRoot, '..', '..');
  const sourceNodeModules = path.join(workspaceRoot, 'node_modules');
  const stagingRoot = path.join(desktopRoot, 'out', 'openspec-runtime');
  // electron-builder intentionally skips a FileSet whose root child is named
  // node_modules. Nest it one level deeper while preserving normal Node module
  // resolution for the embedded CLI.
  const stagingNodeModules = path.join(stagingRoot, 'runtime', 'node_modules');
  assertSafeStagingPath(stagingRoot, desktopRoot);

  const packages = collectDependencyClosure('@fission-ai/openspec', workspaceRoot);
  const openSpec = packages.find((entry) => entry.packageJson.name === '@fission-ai/openspec');
  if (!openSpec || openSpec.packageJson.version !== OPEN_SPEC_VERSION) {
    throw new Error(
      `Expected @fission-ai/openspec@${OPEN_SPEC_VERSION}, found ${openSpec?.packageJson.version || 'nothing'}.`,
    );
  }

  const lock = readJson(path.join(workspaceRoot, 'package-lock.json'));
  const lockEntry = lock.packages?.['node_modules/@fission-ai/openspec'];
  if (
    lockEntry?.version !== OPEN_SPEC_VERSION ||
    lockEntry?.resolved !== OPEN_SPEC_TARBALL_URL ||
    lockEntry?.integrity !== OPEN_SPEC_LOCK_INTEGRITY
  ) {
    throw new Error(
      'The lockfile does not match the reviewed OpenSpec tarball URL and SHA-512 integrity.',
    );
  }

  // Keep the development runtime on the same reviewed Schema bytes as the
  // packaged runtime. This is intentionally done before copying the package
  // closure so a partially prepared node_modules tree cannot enter staging.
  prepareOpenSpecSchemas(openSpec.root);

  if (existsSync(stagingRoot)) {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
  mkdirSync(stagingNodeModules, { recursive: true });

  for (const packageInfo of packages) {
    const relativeRoot = path.relative(sourceNodeModules, packageInfo.root);
    if (
      !relativeRoot ||
      relativeRoot === '..' ||
      relativeRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeRoot)
    ) {
      throw new Error(`OpenSpec dependency resolved outside the workspace node_modules: ${packageInfo.root}`);
    }
    cpSync(
      packageInfo.root,
      path.join(stagingNodeModules, relativeRoot),
      { recursive: true, dereference: false, force: true },
    );
  }

  const openSpecRelativeRoot = path.relative(sourceNodeModules, openSpec.root);
  const stagedOpenSpecRoot = path.join(stagingNodeModules, openSpecRelativeRoot);
  // Inject directly into staging as well. Besides making the packaging
  // boundary explicit, this re-verifies every copied byte.
  const { bundledSchemas } = prepareOpenSpecSchemas(stagedOpenSpecRoot);

  const sortedPackages = packages
    .map((entry) => ({
      name: entry.packageJson.name,
      version: entry.packageJson.version,
      license: entry.packageJson.license || 'UNKNOWN',
      relativeRoot: path.relative(sourceNodeModules, entry.root).replace(/\\/g, '/'),
    }))
    .sort((left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version) ||
      left.relativeRoot.localeCompare(right.relativeRoot),
    );
  const prompts = await promptManifest(openSpec.root);

  writeFileSync(
    path.join(stagingRoot, 'runtime-manifest.json'),
    `${JSON.stringify({
      formatVersion: 3,
      package: '@fission-ai/openspec',
      version: OPEN_SPEC_VERSION,
      tarballSha1: OPEN_SPEC_TARBALL_SHA1,
      tarballUrl: OPEN_SPEC_TARBALL_URL,
      lockIntegrity: OPEN_SPEC_LOCK_INTEGRITY,
      workflowPrompts: prompts,
      bundledSchemas,
      packages: sortedPackages,
    }, null, 2)}\n`,
    'utf8',
  );

  const licenseSections = packages
    .slice()
    .sort((left, right) =>
      left.packageJson.name.localeCompare(right.packageJson.name) ||
      left.packageJson.version.localeCompare(right.packageJson.version),
    )
    .map((entry) => [
      `${entry.packageJson.name}@${entry.packageJson.version}`,
      `SPDX/license field: ${entry.packageJson.license || 'UNKNOWN'}`,
      '',
      licenseText(entry),
    ].join('\n'));
  const bundledSchemaLicense = readFileSync(
    path.join(stagedOpenSpecRoot, ...bundledSchemas[0].licenseFile.split('/')),
    'utf8',
  ).trim();
  licenseSections.push([
    `OpenSpec Schema: ${SCHEMA_NAME}`,
    `Source: ${SCHEMA_REPOSITORY}`,
    `Reviewed commit: ${SCHEMA_COMMIT}`,
    'SPDX/license field: MIT',
    '',
    bundledSchemaLicense,
  ].join('\n'));
  writeFileSync(
    path.join(stagingRoot, 'THIRD_PARTY_LICENSES.txt'),
    [
      `Bundled runtime for @fission-ai/openspec@${OPEN_SPEC_VERSION}`,
      `Recorded npm tarball SHA-1: ${OPEN_SPEC_TARBALL_SHA1}`,
      '',
      licenseSections.join('\n\n' + '='.repeat(78) + '\n\n'),
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(
    `[beforeBuild] Prepared @fission-ai/openspec@${OPEN_SPEC_VERSION} with ` +
      `${packages.length} runtime package directories and ${bundledSchemas.length} bundled Schema.`,
  );
}

module.exports = { prepareOpenSpecRuntime };

if (require.main === module) {
  prepareOpenSpecRuntime().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
