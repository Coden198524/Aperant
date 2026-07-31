import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  OPEN_SPEC_ACTIONS as SHARED_OPEN_SPEC_ACTIONS,
  OPEN_SPEC_VERSION,
  type OpenSpecAction,
  type OpenSpecPromptManifestEntry,
} from '../../shared/types';
import { assertPinnedOpenSpecPackage } from './openspec-package';
import type { OpenSpecRuntimeManifest } from './openspec-package';

interface UpstreamCommandTemplate {
  name?: string;
  description?: string;
  content: string;
}

type UpstreamTemplateFactory = () => UpstreamCommandTemplate;

interface OpenSpecTemplateModule {
  getOpsxExploreCommandTemplate: UpstreamTemplateFactory;
  getOpsxProposeCommandTemplate: UpstreamTemplateFactory;
  getOpsxApplyCommandTemplate: UpstreamTemplateFactory;
  getOpsxUpdateCommandTemplate: UpstreamTemplateFactory;
  getOpsxSyncCommandTemplate: UpstreamTemplateFactory;
  getOpsxArchiveCommandTemplate: UpstreamTemplateFactory;
  getOpsxNewCommandTemplate: UpstreamTemplateFactory;
  getOpsxContinueCommandTemplate: UpstreamTemplateFactory;
  getOpsxFfCommandTemplate: UpstreamTemplateFactory;
  getOpsxVerifyCommandTemplate: UpstreamTemplateFactory;
  getOpsxBulkArchiveCommandTemplate: UpstreamTemplateFactory;
  getOpsxOnboardCommandTemplate: UpstreamTemplateFactory;
}

const FACTORY_NAMES = {
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
} as const satisfies Record<OpenSpecAction, keyof OpenSpecTemplateModule>;

export const OPEN_SPEC_ACTIONS = SHARED_OPEN_SPEC_ACTIONS;

function verifyPromptAgainstRuntimeManifest(
  action: OpenSpecAction,
  prompt: string,
  manifest?: OpenSpecRuntimeManifest,
): void {
  if (!manifest) return;
  const expected = manifest.workflowPrompts.find((entry) => entry.action === action);
  if (!expected) {
    throw new Error(`Packaged OpenSpec prompt manifest is missing action "${action}".`);
  }
  const bytes = Buffer.from(prompt, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== expected.byteLength || sha256 !== expected.sha256) {
    throw new Error(
      `Packaged OpenSpec prompt digest mismatch for action "${action}". Spec actions are disabled.`,
    );
  }
}

export class OpenSpecPromptRegistry {
  private modulePromise: Promise<OpenSpecTemplateModule> | null = null;
  private promptCache = new Map<OpenSpecAction, string>();

  private async loadModule(): Promise<OpenSpecTemplateModule> {
    if (!this.modulePromise) {
      const location = assertPinnedOpenSpecPackage();
      this.modulePromise = import(pathToFileURL(location.promptModule).href) as Promise<OpenSpecTemplateModule>;
    }
    return await this.modulePromise;
  }

  async getPrompt(action: OpenSpecAction): Promise<string> {
    const cached = this.promptCache.get(action);
    if (cached !== undefined) {
      return cached;
    }

    const location = assertPinnedOpenSpecPackage();
    if (location.version !== OPEN_SPEC_VERSION) {
      throw new Error(`Cannot load OpenSpec prompt from version ${location.version}.`);
    }

    const module = await this.loadModule();
    const factoryName = FACTORY_NAMES[action];
    const factory = module[factoryName];
    if (typeof factory !== 'function') {
      throw new Error(`Official OpenSpec prompt factory is missing for action "${action}".`);
    }
    const template = factory();
    if (!template || typeof template.content !== 'string' || template.content.length === 0) {
      throw new Error(`Official OpenSpec prompt is empty for action "${action}".`);
    }
    verifyPromptAgainstRuntimeManifest(
      action,
      template.content,
      location.runtimeManifest,
    );
    this.promptCache.set(action, template.content);
    return template.content;
  }

  async getManifest(): Promise<OpenSpecPromptManifestEntry[]> {
    return await Promise.all(OPEN_SPEC_ACTIONS.map(async (action) => {
      const prompt = await this.getPrompt(action);
      const bytes = Buffer.from(prompt, 'utf8');
      return {
        action,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
      };
    }));
  }
}

export const __openSpecPromptRegistryTestUtils = {
  FACTORY_NAMES,
  verifyPromptAgainstRuntimeManifest,
};
