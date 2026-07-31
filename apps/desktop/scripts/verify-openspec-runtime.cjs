const { createHash } = require('node:crypto');
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const {
  OPEN_SPEC_VERSION,
  SCHEMA_COMMIT,
  SCHEMA_NAME,
  SCHEMA_REPOSITORY,
  verifyBundledSchemas,
} = require('./prepare-openspec-schemas.cjs');

const OPEN_SPEC_TARBALL_SHA1 = '00b6f63e9671153b8621466a9ed423792349b54f';
const OPEN_SPEC_TARBALL_URL =
  'https://registry.npmjs.org/@fission-ai/openspec/-/openspec-1.6.0.tgz';
const OPEN_SPEC_LOCK_INTEGRITY =
  'sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==';
const OPEN_SPEC_ACTIONS = [
  'explore',
  'propose',
  'apply',
  'update',
  'sync',
  'archive',
  'new',
  'continue',
  'ff',
  'verify',
  'bulk-archive',
  'onboard',
];
const ADR_SCHEMA_ARTIFACTS = ['proposal', 'specs', 'design', 'adr', 'tasks'];
const ADR_SCHEMA_INITIAL_STATUS = [
  { id: 'proposal', status: 'ready', missingDeps: [] },
  { id: 'design', status: 'blocked', missingDeps: ['proposal'] },
  { id: 'specs', status: 'blocked', missingDeps: ['proposal'] },
  { id: 'adr', status: 'blocked', missingDeps: ['design'] },
  { id: 'tasks', status: 'blocked', missingDeps: ['adr', 'specs'] },
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function runCli(executable, cliEntry, cwd, args, environment = {}) {
  const result = spawnSync(executable, [cliEntry, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPENSPEC_TELEMETRY: '0',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...environment,
    },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `OpenSpec ${args.join(' ')} failed (${result.status}): ${
        result.stderr?.trim() || result.stdout?.trim()
      }`,
    );
  }
  return result.stdout.trim();
}

function assertSafeSmokeRoot(smokeRoot) {
  const canonicalSmoke = path.resolve(smokeRoot);
  const canonicalTemp = `${path.resolve(tmpdir())}${path.sep}`;
  if (
    !canonicalSmoke.startsWith(canonicalTemp) ||
    !path.basename(canonicalSmoke).startsWith('aperant-openspec-package-')
  ) {
    throw new Error(`Refusing to clean unexpected smoke root: ${canonicalSmoke}`);
  }
}

async function verifyOpenSpecRuntime(runtimeRoot, executable = process.execPath) {
  const canonicalRuntimeRoot = path.resolve(runtimeRoot);
  const canonicalExecutable = path.resolve(executable);
  const manifestPath = path.join(canonicalRuntimeRoot, 'runtime-manifest.json');
  const licensePath = path.join(canonicalRuntimeRoot, 'THIRD_PARTY_LICENSES.txt');
  const packageRoot = path.join(
    canonicalRuntimeRoot,
    'runtime',
    'node_modules',
    '@fission-ai',
    'openspec',
  );
  const cliEntry = path.join(packageRoot, 'bin', 'openspec.js');
  const promptModule = path.join(
    packageRoot,
    'dist',
    'core',
    'templates',
    'skill-templates.js',
  );
  for (const requiredPath of [
    manifestPath,
    licensePath,
    cliEntry,
    promptModule,
    canonicalExecutable,
  ]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`Required packaged OpenSpec runtime file is missing: ${requiredPath}`);
    }
  }

  const manifest = readJson(manifestPath);
  if (
    manifest.formatVersion !== 3 ||
    manifest.package !== '@fission-ai/openspec' ||
    manifest.version !== OPEN_SPEC_VERSION ||
    manifest.tarballSha1 !== OPEN_SPEC_TARBALL_SHA1 ||
    manifest.tarballUrl !== OPEN_SPEC_TARBALL_URL ||
    manifest.lockIntegrity !== OPEN_SPEC_LOCK_INTEGRITY
  ) {
    throw new Error('Packaged OpenSpec manifest does not match the reviewed baseline.');
  }
  if (
    !Array.isArray(manifest.workflowPrompts) ||
    manifest.workflowPrompts.length !== OPEN_SPEC_ACTIONS.length ||
    new Set(manifest.workflowPrompts.map((entry) => entry.action)).size !==
      OPEN_SPEC_ACTIONS.length ||
    OPEN_SPEC_ACTIONS.some(
      (action) => !manifest.workflowPrompts.some((entry) => entry.action === action),
    )
  ) {
    throw new Error('Packaged OpenSpec prompt manifest is incomplete or contains duplicates.');
  }
  verifyBundledSchemas(packageRoot, manifest.bundledSchemas);

  const module = await import(pathToFileURL(promptModule).href);
  for (const entry of manifest.workflowPrompts) {
    const factory = module[entry.factory];
    const prompt = typeof factory === 'function' ? factory()?.content : null;
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new Error(`Packaged OpenSpec prompt factory is missing: ${entry.factory}`);
    }
    const bytes = Buffer.from(prompt, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== entry.byteLength || sha256 !== entry.sha256) {
      throw new Error(`Packaged OpenSpec prompt digest mismatch: ${entry.action}`);
    }
  }

  const license = readFileSync(licensePath, 'utf8');
  if (
    !license.includes(`@fission-ai/openspec@${OPEN_SPEC_VERSION}`) ||
    !license.includes('SPDX/license field: MIT') ||
    !license.includes(`OpenSpec Schema: ${SCHEMA_NAME}`) ||
    !license.includes(`Source: ${SCHEMA_REPOSITORY}`) ||
    !license.includes(`Reviewed commit: ${SCHEMA_COMMIT}`)
  ) {
    throw new Error('Packaged OpenSpec or bundled Schema MIT license notice is missing.');
  }

  const version = runCli(canonicalExecutable, cliEntry, canonicalRuntimeRoot, ['--version']);
  if (version !== OPEN_SPEC_VERSION) {
    throw new Error(`Expected packaged OpenSpec ${OPEN_SPEC_VERSION}, found ${version}.`);
  }

  const smokeRoot = mkdtempSync(path.join(tmpdir(), 'aperant-openspec-package-'));
  try {
    // Smoke validation must exercise the package copy itself, independent of
    // any legitimate user-level Schema override on the build machine.
    const smokeEnvironment = {
      XDG_DATA_HOME: path.join(smokeRoot, '.xdg-data'),
    };
    runCli(
      canonicalExecutable,
      cliEntry,
      smokeRoot,
      ['init', '.', '--tools', 'none'],
      smokeEnvironment,
    );
    const schemaValidation = readJsonOutput(
      runCli(canonicalExecutable, cliEntry, smokeRoot, [
        'schema',
        'validate',
        SCHEMA_NAME,
        '--json',
      ], smokeEnvironment),
      'schema validate',
    );
    if (
      schemaValidation?.name !== SCHEMA_NAME ||
      schemaValidation?.valid !== true ||
      !Array.isArray(schemaValidation?.issues) ||
      typeof schemaValidation?.path !== 'string' ||
      path.resolve(schemaValidation.path) !==
        path.resolve(packageRoot, 'schemas', SCHEMA_NAME)
    ) {
      throw new Error('Packaged OpenSpec ADR Schema failed structural validation.');
    }

    const schemas = readJsonOutput(
      runCli(
        canonicalExecutable,
        cliEntry,
        smokeRoot,
        ['schemas', '--json'],
        smokeEnvironment,
      ),
      'schemas',
    );
    const adrSchema = Array.isArray(schemas)
      ? schemas.find((entry) => entry?.name === SCHEMA_NAME)
      : undefined;
    if (
      !adrSchema ||
      adrSchema.source !== 'package' ||
      !Array.isArray(adrSchema.artifacts) ||
      JSON.stringify(adrSchema.artifacts) !== JSON.stringify(ADR_SCHEMA_ARTIFACTS)
    ) {
      throw new Error('Packaged OpenSpec CLI did not expose the reviewed ADR Schema.');
    }

    const templates = readJsonOutput(
      runCli(canonicalExecutable, cliEntry, smokeRoot, [
        'templates',
        '--schema',
        SCHEMA_NAME,
        '--json',
      ], smokeEnvironment),
      'templates',
    );
    const templateIds =
      templates && typeof templates === 'object' ? Object.keys(templates) : [];
    if (
      !templates ||
      typeof templates !== 'object' ||
      JSON.stringify(templateIds) !== JSON.stringify(ADR_SCHEMA_ARTIFACTS) ||
      ADR_SCHEMA_ARTIFACTS.some(
        (artifactId) =>
          templates[artifactId]?.source !== 'package' ||
          typeof templates[artifactId]?.path !== 'string',
      ) ||
      !templates.adr ||
      templates.adr.source !== 'package' ||
      typeof templates.adr.path !== 'string' ||
      path.basename(templates.adr.path) !== 'adr.md'
    ) {
      throw new Error('Packaged OpenSpec CLI did not resolve the ADR template from the package.');
    }

    const created = readJsonOutput(
      runCli(canonicalExecutable, cliEntry, smokeRoot, [
        'new',
        'change',
        'packaged-runtime-smoke',
        '--schema',
        SCHEMA_NAME,
        '--json',
      ], smokeEnvironment),
      'new change',
    );
    const status = readJsonOutput(
      runCli(canonicalExecutable, cliEntry, smokeRoot, [
        'status',
        '--change',
        'packaged-runtime-smoke',
        '--json',
      ], smokeEnvironment),
      'status',
    );
    const initialStatus = Array.isArray(status?.artifacts)
      ? status.artifacts.map((artifact) => ({
          id: artifact?.id,
          status: artifact?.status,
          missingDeps: Array.isArray(artifact?.missingDeps) ? artifact.missingDeps : [],
        }))
      : [];
    if (
      created?.change?.id !== 'packaged-runtime-smoke' ||
      created?.change?.schema !== SCHEMA_NAME ||
      status?.changeName !== 'packaged-runtime-smoke' ||
      status?.schemaName !== SCHEMA_NAME ||
      !Array.isArray(status?.artifacts) ||
      JSON.stringify(status?.applyRequires) !== JSON.stringify(['tasks']) ||
      JSON.stringify(initialStatus) !== JSON.stringify(ADR_SCHEMA_INITIAL_STATUS)
    ) {
      throw new Error('Packaged OpenSpec ADR Schema CLI contract returned an unexpected shape.');
    }
  } finally {
    assertSafeSmokeRoot(smokeRoot);
    rmSync(smokeRoot, { recursive: true, force: true });
  }

  return {
    runtimeRoot: canonicalRuntimeRoot,
    executable: canonicalExecutable,
    version,
    promptCount: manifest.workflowPrompts.length,
    packageCount: manifest.packages?.length ?? 0,
    schemaCount: manifest.bundledSchemas?.length ?? 0,
  };
}

function readJsonOutput(output, command) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Packaged OpenSpec ${command} returned malformed JSON.`);
  }
}

module.exports = { verifyOpenSpecRuntime };

if (require.main === module) {
  const runtimeRoot =
    process.argv[2] || path.join(__dirname, '..', 'out', 'openspec-runtime');
  const executable = process.argv[3] || process.execPath;
  verifyOpenSpecRuntime(runtimeRoot, executable)
    .then((result) => {
      console.log(
        `[verify-openspec-runtime] Verified OpenSpec ${result.version}, ` +
          `${result.promptCount} prompts, ${result.packageCount} runtime packages, and ` +
          `${result.schemaCount} bundled Schema ` +
          `using ${result.executable}.`,
      );
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
