import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  REQUIRED_APPROVAL_IDS,
  validateCommercialReadiness,
  parseArgs,
} = require('./verify-commercial-readiness.cjs');

const packageJson = {
  name: 'autocode',
  version: '2.8.0-beta.6',
  license: 'AGPL-3.0',
  build: {
    appId: 'com.autocode.app',
    productName: 'Autocode',
  },
};

function createManifest(overrides = {}) {
  const manualApprovals = REQUIRED_APPROVAL_IDS.map((id) => ({
    id,
    label: id,
    status: 'pending',
    owner: 'product',
    requiredFor: 'commercial-ready',
  }));

  return {
    version: '2026-06-14',
    status: 'windows-local-candidate',
    product: {
      packageName: 'autocode',
      packageVersion: '2.8.0-beta.6',
      productName: 'Autocode',
      appId: 'com.autocode.app',
      license: 'AGPL-3.0',
    },
    candidateEvidence: {
      providerModelSupport: {
        status: 'documented',
        path: 'guides/PROVIDER_MODEL_SUPPORT.md',
        version: '2026-06-14',
      },
      tokenCostDisplayPolicy: {
        tokenCounts: 'enabled',
        monetaryEstimates: 'disabled',
      },
      memoryTokenEfficiency: {
        status: 'passed',
        runtimeContextSelection: 'trusted-deduped-ranked',
        maxRuntimeContextChars: 1800,
        checks: [
          'npx vitest run libs/core/src/memory/runtime.test.ts libs/core/src/memory/retrieval/context-packer.test.ts',
        ],
      },
      privacySupport: {
        status: 'documented',
        path: 'guides/PRIVACY_SUPPORT.md',
        version: '2026-06-14',
        telemetryDefault: 'disabled',
        automaticCrashUpload: 'disabled',
        supportLogSharing: 'user-reviewed-redacted',
      },
      windowsPackage: {
        status: 'passed',
        artifactSmoke: 'passed',
        launchSmoke: 'passed',
        requiredArtifacts: [
          'apps/desktop/dist/win-unpacked/Autocode.exe',
          'apps/desktop/dist/win-unpacked/resources/app.asar',
        ],
      },
      verificationBaseline: {
        path: 'openspec/changes/commercial-token-memory-readiness/verification-baseline.md',
      },
      releaseReadinessSummary: {
        path: 'openspec/changes/commercial-token-memory-readiness/release-readiness.md',
      },
      platformScope: {
        verifiedPlatforms: ['windows-x64'],
      },
    },
    commercialReadiness: {
      status: 'not-ready',
    },
    manualApprovals,
    ...overrides,
  };
}

async function withRepoFixture(callback) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'commercial-readiness-'));
  try {
    await mkdir(join(repoRoot, 'guides'), { recursive: true });
    await mkdir(join(repoRoot, 'openspec/changes/commercial-token-memory-readiness'), { recursive: true });
    await mkdir(join(repoRoot, 'apps/desktop/dist/win-unpacked/resources'), { recursive: true });

    await writeFile(
      join(repoRoot, 'guides/PROVIDER_MODEL_SUPPORT.md'),
      '# Provider Model Support Matrix\n\nVersion: 2026-06-14\n\n## Cost Display Policy\n',
    );
    await writeFile(
      join(repoRoot, 'guides/PRIVACY_SUPPORT.md'),
      [
        '# Privacy And Support Policy',
        '',
        'Version: 2026-06-14',
        '',
        'Default telemetry posture: disabled unless explicitly opted in.',
        'Crash diagnostics must not be uploaded automatically.',
        'Users must review or redact logs before sharing them with support.',
      ].join('\n'),
    );
    await writeFile(
      join(repoRoot, 'openspec/changes/commercial-token-memory-readiness/verification-baseline.md'),
      '# Verification Baseline\n\n## Passing Checks\n',
    );
    await writeFile(
      join(repoRoot, 'openspec/changes/commercial-token-memory-readiness/release-readiness.md'),
      '# Release Readiness Summary\n\nStatus: not commercial ready.\n',
    );
    await writeFile(join(repoRoot, 'apps/desktop/dist/win-unpacked/Autocode.exe'), 'exe');
    await writeFile(join(repoRoot, 'apps/desktop/dist/win-unpacked/resources/app.asar'), 'asar');

    return await callback(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

describe('commercial readiness verifier', () => {
  test('passes the candidate target while preserving manual blockers', async () => {
    await withRepoFixture((repoRoot) => {
      const result = validateCommercialReadiness({
        manifest: createManifest(),
        desktopPackageJson: packageJson,
        repoRoot,
      });

      assert.equal(result.verified, true);
      assert.equal(result.target, 'candidate');
      assert.equal(result.blockers.length, REQUIRED_APPROVAL_IDS.length);
      assert.match(result.blockers[0].status, /pending/);
    });
  });

  test('fails the commercial-ready target until approvals are approved', async () => {
    await withRepoFixture((repoRoot) => {
      const result = validateCommercialReadiness({
        manifest: createManifest(),
        desktopPackageJson: packageJson,
        repoRoot,
        target: 'commercial-ready',
      });

      assert.equal(result.verified, false);
      assert.match(result.issues.join('\n'), /Commercial readiness status must be commercial-ready/);
      assert.match(result.issues.join('\n'), /unresolved approval public-brand/);
    });
  });

  test('passes commercial-ready when every required approval is approved', async () => {
    await withRepoFixture((repoRoot) => {
      const approvedManifest = createManifest({
        commercialReadiness: {
          status: 'commercial-ready',
        },
      });
      approvedManifest.manualApprovals = approvedManifest.manualApprovals.map((approval) => ({
        ...approval,
        status: 'approved',
      }));

      const result = validateCommercialReadiness({
        manifest: approvedManifest,
        desktopPackageJson: packageJson,
        repoRoot,
        target: 'commercial-ready',
      });

      assert.equal(result.verified, true);
      assert.equal(result.blockers.length, 0);
    });
  });

  test('fails when package metadata or required documents drift', async () => {
    await withRepoFixture((repoRoot) => {
      const manifest = createManifest({
        product: {
          packageName: 'autocode',
          packageVersion: '0.0.0',
          productName: 'Autocode',
          appId: 'com.autocode.app',
          license: 'AGPL-3.0',
        },
      });
      manifest.candidateEvidence.providerModelSupport.path = 'guides/MISSING.md';
      manifest.candidateEvidence.privacySupport.telemetryDefault = 'enabled';

      const result = validateCommercialReadiness({
        manifest,
        desktopPackageJson: packageJson,
        repoRoot,
      });

      assert.equal(result.verified, false);
      assert.match(result.issues.join('\n'), /packageVersion/);
      assert.match(result.issues.join('\n'), /provider\/model support document is missing/);
      assert.match(result.issues.join('\n'), /disabled-by-default telemetry/);
    });
  });

  test('parses manifest path and target arguments', () => {
    assert.deepEqual(parseArgs(['guides/readiness.json', '--target=commercial-ready']), {
      manifestPath: 'guides/readiness.json',
      target: 'commercial-ready',
    });
  });
});
