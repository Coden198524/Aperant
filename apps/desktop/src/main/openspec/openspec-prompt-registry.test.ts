import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  OPEN_SPEC_TARBALL_SHA1,
  OPEN_SPEC_VERSION,
  type OpenSpecAction,
} from '../../shared/types';
import {
  OpenSpecPromptRegistry,
  OPEN_SPEC_ACTIONS,
  __openSpecPromptRegistryTestUtils,
} from './openspec-prompt-registry';
import { assertPinnedOpenSpecPackage } from './openspec-package';

describe('OpenSpecPromptRegistry', () => {
  it('uses the pinned upstream package and recorded tarball digest', () => {
    const location = assertPinnedOpenSpecPackage();
    expect(location.version).toBe(OPEN_SPEC_VERSION);
    expect(OPEN_SPEC_VERSION).toBe('1.6.0');
    expect(OPEN_SPEC_TARBALL_SHA1).toBe('00b6f63e9671153b8621466a9ed423792349b54f');
  });

  it('returns every official Action prompt byte-for-byte', async () => {
    const location = assertPinnedOpenSpecPackage();
    const upstream = await import(pathToFileURL(location.promptModule).href) as Record<
      string,
      () => { content: string }
    >;
    const registry = new OpenSpecPromptRegistry();

    expect(OPEN_SPEC_ACTIONS).toHaveLength(12);
    for (const action of OPEN_SPEC_ACTIONS) {
      const factoryName = __openSpecPromptRegistryTestUtils.FACTORY_NAMES[action];
      const expected = upstream[factoryName]().content;
      const actual = await registry.getPrompt(action);
      expect(Buffer.from(actual, 'utf8').equals(Buffer.from(expected, 'utf8'))).toBe(true);
    }
  });

  it('publishes a stable byte manifest for all Actions', async () => {
    const registry = new OpenSpecPromptRegistry();
    const manifest = await registry.getManifest();
    expect(new Set(manifest.map((entry) => entry.action))).toEqual(
      new Set<OpenSpecAction>(OPEN_SPEC_ACTIONS),
    );
    for (const entry of manifest) {
      const bytes = Buffer.from(await registry.getPrompt(entry.action), 'utf8');
      expect(entry.byteLength).toBe(bytes.byteLength);
      expect(entry.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });
});
