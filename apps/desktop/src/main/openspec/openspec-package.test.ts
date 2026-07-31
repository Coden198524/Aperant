import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  OPEN_SPEC_ACTIONS,
  OPEN_SPEC_TARBALL_SHA1,
  OPEN_SPEC_VERSION,
} from '../../shared/types';
import type { OpenSpecRuntimeManifest } from './openspec-package';
import {
  __openSpecPackageTestUtils,
  assertPinnedOpenSpecPackage,
} from './openspec-package';
import { __openSpecPromptRegistryTestUtils } from './openspec-prompt-registry';

function runtimeManifest(): OpenSpecRuntimeManifest {
  return {
    formatVersion: 3,
    package: '@fission-ai/openspec',
    version: OPEN_SPEC_VERSION,
    tarballSha1: OPEN_SPEC_TARBALL_SHA1,
    tarballUrl: __openSpecPackageTestUtils.OPEN_SPEC_TARBALL_URL,
    lockIntegrity: __openSpecPackageTestUtils.OPEN_SPEC_LOCK_INTEGRITY,
    workflowPrompts: OPEN_SPEC_ACTIONS.map((action) => ({
      action,
      factory: `factory-${action}`,
      source: 'dist/core/templates/skill-templates.js',
      byteLength: 10,
      sha256: 'a'.repeat(64),
    })),
    bundledSchemas: __openSpecPackageTestUtils.expectedBundledSchemas(),
    packages: [
      {
        name: '@fission-ai/openspec',
        version: OPEN_SPEC_VERSION,
        license: 'MIT',
        relativeRoot: '@fission-ai/openspec',
      },
    ],
  };
}

describe('packaged OpenSpec runtime manifest', () => {
  it('exposes the exact node_modules root that contains the scoped runtime package', () => {
    const location = assertPinnedOpenSpecPackage();
    expect(location.runtimeNodeModulesRoot).toBe(
      resolve(location.packageRoot, '..', '..'),
    );
    expect(
      resolve(
        location.runtimeNodeModulesRoot,
        '@fission-ai',
        'openspec',
      ),
    ).toBe(resolve(location.packageRoot));

    const packagedNodeModulesRoot = join(
      tmpdir(),
      'Aperant',
      'resources',
      'openspec',
      OPEN_SPEC_VERSION,
      'runtime',
      'node_modules',
    );
    expect(__openSpecPackageTestUtils.resolveRuntimeNodeModulesRoot(
      join(packagedNodeModulesRoot, '@fission-ai', 'openspec'),
    )).toBe(resolve(packagedNodeModulesRoot));
    expect(() => __openSpecPackageTestUtils.resolveRuntimeNodeModulesRoot(
      join(tmpdir(), 'runtime', 'vendor', '@fission-ai', 'openspec'),
    )).toThrow(/node_modules\/@fission-ai\/openspec/);
  });

  it('accepts only the complete pinned baseline and MIT notice', () => {
    const manifest = runtimeManifest();
    expect(__openSpecPackageTestUtils.parseRuntimeManifest(
      manifest,
      [
        '@fission-ai/openspec@1.6.0',
        'SPDX/license field: MIT',
        'OpenSpec Schema: spec-driven-with-adr',
        'Source: https://github.com/intent-driven-dev/openspec-schemas',
        'Reviewed commit: 87ec4decf3151b0d7d10b7bf0f6ad9c7e74eccc0',
        'MIT License',
      ].join('\n'),
    )).toEqual(manifest);
  });

  it('rejects supply-chain drift, incomplete Actions, and a missing license notice', () => {
    expect(() => __openSpecPackageTestUtils.parseRuntimeManifest(
      {
        ...runtimeManifest(),
        tarballSha1: '0'.repeat(40),
      },
      [
        '@fission-ai/openspec@1.6.0',
        'SPDX/license field: MIT',
        'OpenSpec Schema: spec-driven-with-adr',
        'Source: https://github.com/intent-driven-dev/openspec-schemas',
        'Reviewed commit: 87ec4decf3151b0d7d10b7bf0f6ad9c7e74eccc0',
      ].join('\n'),
    )).toThrow(/supply-chain baseline/);

    expect(() => __openSpecPackageTestUtils.parseRuntimeManifest(
      {
        ...runtimeManifest(),
        workflowPrompts: runtimeManifest().workflowPrompts.slice(1),
      },
      [
        '@fission-ai/openspec@1.6.0',
        'SPDX/license field: MIT',
        'OpenSpec Schema: spec-driven-with-adr',
        'Source: https://github.com/intent-driven-dev/openspec-schemas',
        'Reviewed commit: 87ec4decf3151b0d7d10b7bf0f6ad9c7e74eccc0',
      ].join('\n'),
    )).toThrow(/incomplete/);

    expect(() => __openSpecPackageTestUtils.parseRuntimeManifest(
      runtimeManifest(),
      'no bundled license entry',
    )).toThrow(/MIT license notice is missing/);
  });

  it('rejects bundled ADR Schema provenance or digest drift', () => {
    const manifest = runtimeManifest();
    manifest.bundledSchemas[0].commit = '0'.repeat(40) as never;
    expect(() => __openSpecPackageTestUtils.parseRuntimeManifest(
      manifest,
      [
        '@fission-ai/openspec@1.6.0',
        'SPDX/license field: MIT',
        'OpenSpec Schema: spec-driven-with-adr',
        'Source: https://github.com/intent-driven-dev/openspec-schemas',
        'Reviewed commit: 87ec4decf3151b0d7d10b7bf0f6ad9c7e74eccc0',
      ].join('\n'),
    )).toThrow(/bundled Schema manifest/);

    const digestDrift = runtimeManifest();
    digestDrift.bundledSchemas[0].files[0].sha256 = '0'.repeat(64);
    expect(() => __openSpecPackageTestUtils.parseRuntimeManifest(
      digestDrift,
      [
        '@fission-ai/openspec@1.6.0',
        'SPDX/license field: MIT',
        'OpenSpec Schema: spec-driven-with-adr',
        'Source: https://github.com/intent-driven-dev/openspec-schemas',
        'Reviewed commit: 87ec4decf3151b0d7d10b7bf0f6ad9c7e74eccc0',
      ].join('\n'),
    )).toThrow(/bundled Schema manifest/);
  });

  it('fails closed when installed ADR Schema bytes differ from the manifest', () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-package-test-'));
    try {
      const resourceRoot = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../resources/openspec-schemas',
      );
      const schemaRoot = join(packageRoot, 'schemas', 'spec-driven-with-adr');
      mkdirSync(join(packageRoot, 'schemas'), { recursive: true });
      cpSync(join(resourceRoot, 'spec-driven-with-adr'), schemaRoot, {
        recursive: true,
      });
      copyFileSync(
        join(resourceRoot, 'manifest.json'),
        join(schemaRoot, 'openspec-schemas.provenance.json'),
      );
      copyFileSync(
        join(resourceRoot, 'LICENSE'),
        join(schemaRoot, 'openspec-schemas.LICENSE'),
      );
      const bundledSchemas = __openSpecPackageTestUtils.expectedBundledSchemas();

      expect(() => __openSpecPackageTestUtils.verifyBundledSchemaFiles(
        packageRoot,
        bundledSchemas,
      )).not.toThrow();

      appendFileSync(join(schemaRoot, 'schema.yaml'), '\r\nunreviewed: true\r\n');
      expect(() => __openSpecPackageTestUtils.verifyBundledSchemaFiles(
        packageRoot,
        bundledSchemas,
      )).toThrow(/reviewed LF-only byte digest/);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when packaged prompt bytes differ from their manifest digest', () => {
    const prompt = 'official prompt bytes\n';
    const bytes = Buffer.from(prompt, 'utf8');
    const manifest = runtimeManifest();
    manifest.workflowPrompts = manifest.workflowPrompts.map((entry) =>
      entry.action === 'apply'
        ? {
            ...entry,
            byteLength: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }
        : entry,
    );

    expect(() => __openSpecPromptRegistryTestUtils.verifyPromptAgainstRuntimeManifest(
      'apply',
      prompt,
      manifest,
    )).not.toThrow();
    expect(() => __openSpecPromptRegistryTestUtils.verifyPromptAgainstRuntimeManifest(
      'apply',
      `${prompt}tampered`,
      manifest,
    )).toThrow(/prompt digest mismatch/);
  });
});
