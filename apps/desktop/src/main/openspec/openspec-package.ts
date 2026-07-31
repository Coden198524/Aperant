import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

import {
  OPEN_SPEC_ACTIONS,
  OPEN_SPEC_TARBALL_SHA1,
  OPEN_SPEC_VERSION,
  type OpenSpecAction,
} from '../../shared/types';

const require = createRequire(import.meta.url);

export interface OpenSpecPackageLocation {
  packageRoot: string;
  runtimeNodeModulesRoot: string;
  packageJsonPath: string;
  cliEntry: string;
  promptModule: string;
  version: string;
  runtimeManifestPath?: string;
  thirdPartyLicensesPath?: string;
  runtimeManifest?: OpenSpecRuntimeManifest;
}

export interface OpenSpecCommandShim {
  directory: string;
  commandEnv: Record<string, string>;
}

let cachedLocation: OpenSpecPackageLocation | null = null;
let cachedShim: OpenSpecCommandShim | null = null;

const OPEN_SPEC_TARBALL_URL =
  'https://registry.npmjs.org/@fission-ai/openspec/-/openspec-1.6.0.tgz' as const;
const OPEN_SPEC_LOCK_INTEGRITY =
  'sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==' as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPEN_SPEC_ADR_SCHEMA_NAME = 'spec-driven-with-adr' as const;
const OPEN_SPEC_ADR_SCHEMA_REPOSITORY =
  'https://github.com/intent-driven-dev/openspec-schemas' as const;
const OPEN_SPEC_ADR_SCHEMA_COMMIT =
  '87ec4decf3151b0d7d10b7bf0f6ad9c7e74eccc0' as const;
const OPEN_SPEC_ADR_SCHEMA_LICENSE_SHA256 =
  '1126322e2cc8d165adc4c792eeb195717de2bcc7b39be1ce77959d78e87ef685' as const;
const OPEN_SPEC_ADR_SCHEMA_LICENSE_BYTE_LENGTH = 1056 as const;

export interface OpenSpecRuntimePromptManifestEntry {
  action: OpenSpecAction;
  factory: string;
  source: string;
  byteLength: number;
  sha256: string;
}

export interface OpenSpecBundledSchemaManifestEntry {
  name: typeof OPEN_SPEC_ADR_SCHEMA_NAME;
  repository: typeof OPEN_SPEC_ADR_SCHEMA_REPOSITORY;
  commit: typeof OPEN_SPEC_ADR_SCHEMA_COMMIT;
  license: 'MIT';
  sourcePath: 'openspec/schemas/spec-driven-with-adr';
  minimumOpenSpecVersion: '1.0.0';
  relativeRoot: 'schemas/spec-driven-with-adr';
  provenanceFile: 'schemas/spec-driven-with-adr/openspec-schemas.provenance.json';
  licenseFile: 'schemas/spec-driven-with-adr/openspec-schemas.LICENSE';
  licenseByteLength: typeof OPEN_SPEC_ADR_SCHEMA_LICENSE_BYTE_LENGTH;
  licenseSha256: typeof OPEN_SPEC_ADR_SCHEMA_LICENSE_SHA256;
  files: Array<{
    path: string;
    byteLength: number;
    sha256: string;
  }>;
}

export interface OpenSpecRuntimeManifest {
  formatVersion: 3;
  package: '@fission-ai/openspec';
  version: typeof OPEN_SPEC_VERSION;
  tarballSha1: typeof OPEN_SPEC_TARBALL_SHA1;
  tarballUrl: typeof OPEN_SPEC_TARBALL_URL;
  lockIntegrity: typeof OPEN_SPEC_LOCK_INTEGRITY;
  workflowPrompts: OpenSpecRuntimePromptManifestEntry[];
  bundledSchemas: OpenSpecBundledSchemaManifestEntry[];
  packages: Array<{
    name: string;
    version: string;
    license: string;
    relativeRoot: string;
  }>;
}

const OPEN_SPEC_ADR_SCHEMA_FILES = [
  {
    path: 'README.md',
    byteLength: 2505,
    sha256: '2e4bfb47877c9bf0a25f34c7ac596abebdb77c3caef52168394393a0ae0dad20',
  },
  {
    path: 'schema.yaml',
    byteLength: 11537,
    sha256: 'eae18d55e431fdd707a042e869c0ed89686f43d6b180723015e97ce34a97c272',
  },
  {
    path: 'templates/adr.md',
    byteLength: 818,
    sha256: '121d39dccc6bad2b210e990bacad3825284ecf2a63037439452932536c9b03db',
  },
  {
    path: 'templates/design.md',
    byteLength: 302,
    sha256: '3251f08057d142f6e3c26f65f5f100ab602ee7ce880d5503bfaa45668ba19f59',
  },
  {
    path: 'templates/proposal.md',
    byteLength: 888,
    sha256: '9c554e0dbe918e3dc745dcc143a999e1d102954d75fb6e51e231c4cba78f06f3',
  },
  {
    path: 'templates/spec.md',
    byteLength: 198,
    sha256: 'e025078f238dc6e4df552a1e0a140cf9efce0bbdecbeb9f45837d45ed91dca01',
  },
  {
    path: 'templates/tasks.md',
    byteLength: 209,
    sha256: 'b2a6a4c08c15f347a1d8c3e2d43e0c8fb066dc5cc0feb795f47555f176f9c421',
  },
] as const;

function expectedBundledSchemas(): OpenSpecBundledSchemaManifestEntry[] {
  return [
    {
      name: OPEN_SPEC_ADR_SCHEMA_NAME,
      repository: OPEN_SPEC_ADR_SCHEMA_REPOSITORY,
      commit: OPEN_SPEC_ADR_SCHEMA_COMMIT,
      license: 'MIT',
      sourcePath: 'openspec/schemas/spec-driven-with-adr',
      minimumOpenSpecVersion: '1.0.0',
      relativeRoot: 'schemas/spec-driven-with-adr',
      provenanceFile:
        'schemas/spec-driven-with-adr/openspec-schemas.provenance.json',
      licenseFile: 'schemas/spec-driven-with-adr/openspec-schemas.LICENSE',
      licenseByteLength: OPEN_SPEC_ADR_SCHEMA_LICENSE_BYTE_LENGTH,
      licenseSha256: OPEN_SPEC_ADR_SCHEMA_LICENSE_SHA256,
      files: OPEN_SPEC_ADR_SCHEMA_FILES.map((entry) => ({ ...entry })),
    },
  ];
}

function expectedSchemaProvenanceManifest(): Record<string, unknown> {
  return {
    formatVersion: 1,
    repository: OPEN_SPEC_ADR_SCHEMA_REPOSITORY,
    commit: OPEN_SPEC_ADR_SCHEMA_COMMIT,
    license: 'MIT',
    licenseFile: 'LICENSE',
    licenseByteLength: OPEN_SPEC_ADR_SCHEMA_LICENSE_BYTE_LENGTH,
    licenseSha256: OPEN_SPEC_ADR_SCHEMA_LICENSE_SHA256,
    schemas: [
      {
        name: OPEN_SPEC_ADR_SCHEMA_NAME,
        sourcePath: 'openspec/schemas/spec-driven-with-adr',
        minimumOpenSpecVersion: '1.0.0',
        files: OPEN_SPEC_ADR_SCHEMA_FILES.map((entry) => ({ ...entry })),
      },
    ],
  };
}

interface OpenSpecPackageCandidate {
  packageRoot: string;
  runtimeNodeModulesRoot: string;
  runtimeRoot?: string;
}

function packageRootFromMain(mainPath: string): string {
  return dirname(dirname(mainPath));
}

function sameResolvedPath(firstPath: string, secondPath: string): boolean {
  const first = resolve(firstPath);
  const second = resolve(secondPath);
  return process.platform === 'win32'
    ? first.toLocaleLowerCase('en-US') === second.toLocaleLowerCase('en-US')
    : first === second;
}

function resolveRuntimeNodeModulesRoot(packageRoot: string): string {
  const resolvedPackageRoot = resolve(packageRoot);
  const runtimeNodeModulesRoot = dirname(dirname(resolvedPackageRoot));
  const expectedPackageRoot = join(
    runtimeNodeModulesRoot,
    '@fission-ai',
    'openspec',
  );
  if (
    basename(runtimeNodeModulesRoot) !== 'node_modules' ||
    !sameResolvedPath(resolvedPackageRoot, expectedPackageRoot)
  ) {
    throw new Error(
      'The pinned OpenSpec package must be located directly under node_modules/@fission-ai/openspec.',
    );
  }
  return runtimeNodeModulesRoot;
}

function candidatePackageRoots(): OpenSpecPackageCandidate[] {
  const candidates: OpenSpecPackageCandidate[] = [];
  try {
    const packageRoot = packageRootFromMain(require.resolve('@fission-ai/openspec'));
    candidates.push({
      packageRoot,
      runtimeNodeModulesRoot: resolveRuntimeNodeModulesRoot(packageRoot),
    });
  } catch {
    // Packaged builds use the explicit versioned Resources fallback below.
  }

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const runtimeRoot = join(resourcesPath, 'openspec', OPEN_SPEC_VERSION);
    const runtimeNodeModulesRoot = join(runtimeRoot, 'runtime', 'node_modules');
    candidates.push({
      packageRoot: join(
        runtimeNodeModulesRoot,
        '@fission-ai',
        'openspec',
      ),
      runtimeNodeModulesRoot,
      runtimeRoot,
    });
  }

  const seen = new Set<string>();
  return candidates
    .map((candidate) => ({
      packageRoot: resolve(candidate.packageRoot),
      runtimeNodeModulesRoot: resolve(candidate.runtimeNodeModulesRoot),
      ...(candidate.runtimeRoot ? { runtimeRoot: resolve(candidate.runtimeRoot) } : {}),
    }))
    .filter((candidate) => {
      if (seen.has(candidate.packageRoot)) return false;
      seen.add(candidate.packageRoot);
      return true;
    });
}

function assertBundledSchemaManifest(
  value: unknown,
): asserts value is OpenSpecBundledSchemaManifestEntry[] {
  if (!isDeepStrictEqual(value, expectedBundledSchemas())) {
    throw new Error(
      'The packaged OpenSpec bundled Schema manifest does not match the pinned supply-chain baseline.',
    );
  }
}

function resolvePackageFile(packageRoot: string, relativePath: string): string {
  const segments = relativePath.split('/');
  if (
    !relativePath ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`The bundled OpenSpec Schema path is unsafe: ${relativePath}`);
  }
  const resolvedRoot = resolve(packageRoot);
  const resolvedFile = resolve(resolvedRoot, ...segments);
  const relativeFile = relative(resolvedRoot, resolvedFile);
  if (
    !relativeFile ||
    relativeFile === '..' ||
    relativeFile.startsWith(`..${sep}`) ||
    isAbsolute(relativeFile)
  ) {
    throw new Error(`The bundled OpenSpec Schema path escapes its package: ${relativePath}`);
  }
  return resolvedFile;
}

function assertPinnedSchemaFile(
  filePath: string,
  expected: { byteLength: number; sha256: string },
  label: string,
): void {
  if (!existsSync(filePath)) {
    throw new Error(`The ${label} is missing: ${filePath}`);
  }
  const bytes = readFileSync(filePath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (
    bytes.includes(0x0d) ||
    bytes.byteLength !== expected.byteLength ||
    digest !== expected.sha256
  ) {
    throw new Error(`The ${label} does not match the reviewed LF-only byte digest.`);
  }
}

function verifyBundledSchemaFiles(
  packageRoot: string,
  bundledSchemas: unknown,
): asserts bundledSchemas is OpenSpecBundledSchemaManifestEntry[] {
  assertBundledSchemaManifest(bundledSchemas);
  const bundledSchema = bundledSchemas[0];
  for (const file of bundledSchema.files) {
    assertPinnedSchemaFile(
      resolvePackageFile(packageRoot, `${bundledSchema.relativeRoot}/${file.path}`),
      file,
      `bundled OpenSpec Schema file "${file.path}"`,
    );
  }
  assertPinnedSchemaFile(
    resolvePackageFile(packageRoot, bundledSchema.licenseFile),
    {
      byteLength: bundledSchema.licenseByteLength,
      sha256: bundledSchema.licenseSha256,
    },
    'bundled OpenSpec Schema upstream license',
  );

  const provenancePath = resolvePackageFile(packageRoot, bundledSchema.provenanceFile);
  if (!existsSync(provenancePath)) {
    throw new Error(`The bundled OpenSpec Schema provenance manifest is missing: ${provenancePath}`);
  }
  const provenanceBytes = readFileSync(provenancePath);
  if (provenanceBytes.includes(0x0d)) {
    throw new Error('The bundled OpenSpec Schema provenance manifest must use LF-only bytes.');
  }
  let provenance: unknown;
  try {
    provenance = JSON.parse(provenanceBytes.toString('utf8'));
  } catch {
    throw new Error('The bundled OpenSpec Schema provenance manifest is malformed.');
  }
  if (!isDeepStrictEqual(provenance, expectedSchemaProvenanceManifest())) {
    throw new Error(
      'The bundled OpenSpec Schema provenance does not match the pinned supply-chain baseline.',
    );
  }
}

function parseRuntimeManifest(
  value: unknown,
  thirdPartyLicenseText: string,
): OpenSpecRuntimeManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The packaged OpenSpec runtime manifest is invalid.');
  }
  const manifest = value as Partial<OpenSpecRuntimeManifest>;
  if (
    manifest.formatVersion !== 3 ||
    manifest.package !== '@fission-ai/openspec' ||
    manifest.version !== OPEN_SPEC_VERSION ||
    manifest.tarballSha1 !== OPEN_SPEC_TARBALL_SHA1 ||
    manifest.tarballUrl !== OPEN_SPEC_TARBALL_URL ||
    manifest.lockIntegrity !== OPEN_SPEC_LOCK_INTEGRITY
  ) {
    throw new Error('The packaged OpenSpec runtime manifest does not match the pinned supply-chain baseline.');
  }
  if (!Array.isArray(manifest.workflowPrompts)) {
    throw new Error('The packaged OpenSpec workflow prompt manifest is missing.');
  }
  const expectedActions = new Set<OpenSpecAction>(OPEN_SPEC_ACTIONS);
  const actualActions = new Set<OpenSpecAction>();
  for (const entry of manifest.workflowPrompts) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !expectedActions.has(entry.action) ||
      actualActions.has(entry.action) ||
      typeof entry.factory !== 'string' ||
      !entry.factory ||
      entry.source !== 'dist/core/templates/skill-templates.js' ||
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength <= 0 ||
      typeof entry.sha256 !== 'string' ||
      !SHA256_PATTERN.test(entry.sha256)
    ) {
      throw new Error('The packaged OpenSpec workflow prompt manifest contains an invalid entry.');
    }
    actualActions.add(entry.action);
  }
  if (
    actualActions.size !== expectedActions.size ||
    OPEN_SPEC_ACTIONS.some((action) => !actualActions.has(action))
  ) {
    throw new Error('The packaged OpenSpec workflow prompt manifest is incomplete.');
  }
  assertBundledSchemaManifest(manifest.bundledSchemas);
  if (!Array.isArray(manifest.packages)) {
    throw new Error('The packaged OpenSpec dependency manifest is missing.');
  }
  const openSpecPackage = manifest.packages.find(
    (entry) => entry?.name === '@fission-ai/openspec',
  );
  if (
    !openSpecPackage ||
    openSpecPackage.version !== OPEN_SPEC_VERSION ||
    openSpecPackage.license !== 'MIT'
  ) {
    throw new Error('The packaged OpenSpec dependency manifest does not include the pinned MIT package.');
  }
  if (
    !thirdPartyLicenseText.includes(`@fission-ai/openspec@${OPEN_SPEC_VERSION}`) ||
    !thirdPartyLicenseText.includes('SPDX/license field: MIT') ||
    !thirdPartyLicenseText.includes(`OpenSpec Schema: ${OPEN_SPEC_ADR_SCHEMA_NAME}`) ||
    !thirdPartyLicenseText.includes(`Source: ${OPEN_SPEC_ADR_SCHEMA_REPOSITORY}`) ||
    !thirdPartyLicenseText.includes(`Reviewed commit: ${OPEN_SPEC_ADR_SCHEMA_COMMIT}`)
  ) {
    throw new Error('The packaged OpenSpec or bundled Schema MIT license notice is missing.');
  }
  return manifest as OpenSpecRuntimeManifest;
}

function validatePackageCandidate(
  candidate: OpenSpecPackageCandidate,
): OpenSpecPackageLocation | null {
  const { packageRoot, runtimeNodeModulesRoot, runtimeRoot } = candidate;
  let expectedRuntimeNodeModulesRoot: string;
  try {
    expectedRuntimeNodeModulesRoot = resolveRuntimeNodeModulesRoot(packageRoot);
  } catch {
    return null;
  }
  if (!sameResolvedPath(runtimeNodeModulesRoot, expectedRuntimeNodeModulesRoot)) {
    return null;
  }
  const packageJsonPath = join(packageRoot, 'package.json');
  const cliEntry = join(packageRoot, 'bin', 'openspec.js');
  const promptModule = join(packageRoot, 'dist', 'core', 'templates', 'skill-templates.js');
  if (!existsSync(packageJsonPath) || !existsSync(cliEntry) || !existsSync(promptModule)) {
    return null;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name?: unknown;
    version?: unknown;
    license?: unknown;
  };
  if (
    packageJson.name !== '@fission-ai/openspec' ||
    typeof packageJson.version !== 'string' ||
    packageJson.license !== 'MIT'
  ) {
    return null;
  }

  let runtimeManifestPath: string | undefined;
  let thirdPartyLicensesPath: string | undefined;
  let runtimeManifest: OpenSpecRuntimeManifest | undefined;
  if (runtimeRoot) {
    runtimeManifestPath = join(runtimeRoot, 'runtime-manifest.json');
    thirdPartyLicensesPath = join(runtimeRoot, 'THIRD_PARTY_LICENSES.txt');
    if (!existsSync(runtimeManifestPath) || !existsSync(thirdPartyLicensesPath)) {
      throw new Error('The packaged OpenSpec runtime manifest or third-party license file is missing.');
    }
    runtimeManifest = parseRuntimeManifest(
      JSON.parse(readFileSync(runtimeManifestPath, 'utf8')),
      readFileSync(thirdPartyLicensesPath, 'utf8'),
    );
  }
  verifyBundledSchemaFiles(
    packageRoot,
    runtimeManifest?.bundledSchemas ?? expectedBundledSchemas(),
  );

  return {
    packageRoot,
    runtimeNodeModulesRoot,
    packageJsonPath,
    cliEntry,
    promptModule,
    version: packageJson.version,
    ...(runtimeManifestPath ? { runtimeManifestPath } : {}),
    ...(thirdPartyLicensesPath ? { thirdPartyLicensesPath } : {}),
    ...(runtimeManifest ? { runtimeManifest } : {}),
  };
}

export function locateOpenSpecPackage(): OpenSpecPackageLocation {
  if (cachedLocation) {
    return cachedLocation;
  }

  for (const candidate of candidatePackageRoots()) {
    const location = validatePackageCandidate(candidate);
    if (location) {
      cachedLocation = location;
      return cachedLocation;
    }
  }

  throw new Error(
    `Bundled OpenSpec runtime was not found. Expected @fission-ai/openspec@${OPEN_SPEC_VERSION}.`,
  );
}

export function assertPinnedOpenSpecPackage(): OpenSpecPackageLocation {
  const location = locateOpenSpecPackage();
  if (location.version !== OPEN_SPEC_VERSION) {
    throw new Error(
      `OpenSpec version mismatch: expected ${OPEN_SPEC_VERSION}, found ${location.version}. Spec actions are disabled.`,
    );
  }
  return location;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Official workflow prompts invoke `openspec` by name. This shim puts the
 * application-pinned CLI first on PATH without consulting a global install.
 */
export function ensureOpenSpecCommandShim(): OpenSpecCommandShim {
  if (cachedShim) {
    return cachedShim;
  }

  const location = assertPinnedOpenSpecPackage();
  const locationDigest = createHash('sha256')
    .update(`${process.execPath}\0${location.cliEntry}`)
    .digest('hex')
    .slice(0, 16);
  const directory = join(
    tmpdir(),
    'aperant-openspec-runtime',
    OPEN_SPEC_VERSION,
    locationDigest,
  );
  mkdirSync(directory, { recursive: true });

  const normalizedExecPath = process.execPath.replace(/\\/g, '/');
  const normalizedCliEntry = location.cliEntry.replace(/\\/g, '/');
  const posixShim = [
    '#!/usr/bin/env sh',
    'export ELECTRON_RUN_AS_NODE=1',
    'export OPENSPEC_TELEMETRY=0',
    `exec ${quotePosix(normalizedExecPath)} ${quotePosix(normalizedCliEntry)} "$@"`,
    '',
  ].join('\n');
  const cmdShim = [
    '@echo off',
    'set "ELECTRON_RUN_AS_NODE=1"',
    'set "OPENSPEC_TELEMETRY=0"',
    `${quoteCmd(process.execPath)} ${quoteCmd(location.cliEntry)} %*`,
    '',
  ].join('\r\n');

  const posixPath = join(directory, 'openspec');
  const cmdPath = join(directory, 'openspec.cmd');
  writeFileSync(posixPath, posixShim, 'utf8');
  writeFileSync(cmdPath, cmdShim, 'utf8');
  if (process.platform !== 'win32') {
    chmodSync(posixPath, 0o755);
  }

  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  cachedShim = {
    directory,
    commandEnv: {
      PATH: pathValue ? `${directory}${process.platform === 'win32' ? ';' : ':'}${pathValue}` : directory,
      OPENSPEC_TELEMETRY: '0',
    },
  };
  return cachedShim;
}

export function __resetOpenSpecPackageCacheForTests(): void {
  cachedLocation = null;
  cachedShim = null;
}

export const __openSpecPackageTestUtils = {
  OPEN_SPEC_LOCK_INTEGRITY,
  OPEN_SPEC_TARBALL_URL,
  expectedBundledSchemas,
  parseRuntimeManifest,
  resolveRuntimeNodeModulesRoot,
  validatePackageCandidate,
  verifyBundledSchemaFiles,
} as const;
