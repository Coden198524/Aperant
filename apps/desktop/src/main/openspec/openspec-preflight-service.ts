import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type {
  OpenSpecPreflightCheck,
  OpenSpecPreflightInput,
  OpenSpecPreflightResult,
  OpenSpecRootKind,
  Project,
} from '../../shared/types';
import { OPEN_SPEC_VERSION } from '../../shared/types';
import { OpenSpecCliAdapter, type OpenSpecCliScope } from './openspec-cli-adapter';

const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,127}$/;

interface RawStoreList {
  stores?: Array<{
    id?: unknown;
    root?: unknown;
  }>;
}

interface RawSchema {
  name?: unknown;
}

interface RawChangeList {
  changes?: Array<{
    name?: unknown;
  }>;
}

interface RawContext {
  root?: {
    path?: unknown;
  };
}

function canonicalProjectRoot(project: Project): string {
  const root = realpathSync.native(resolve(project.path));
  if (!statSync(root).isDirectory()) {
    throw new Error('The selected project root is not a directory.');
  }
  return root;
}

function identifier(value: string | undefined, fallback: string, label: string): string {
  const normalized = value?.trim() || fallback;
  if (!SAFE_IDENTIFIER.test(normalized)) {
    throw new Error(`${label} must be a kebab-case OpenSpec identifier.`);
  }
  return normalized;
}

function check(
  code: OpenSpecPreflightCheck['code'],
  ok: boolean,
  message: string,
  severity: OpenSpecPreflightCheck['severity'] = ok ? 'info' : 'error',
): OpenSpecPreflightCheck {
  return { code, ok, message, severity };
}

function gitWorktreeCheck(root: string): OpenSpecPreflightCheck {
  try {
    const output = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return check(
      'worktree',
      output === 'true',
      output === 'true'
        ? 'The project can create an isolated Git worktree when the task starts.'
        : 'The project is not inside a Git worktree.',
      output === 'true' ? 'info' : 'error',
    );
  } catch {
    return check(
      'worktree',
      false,
      'The project must be a Git repository to use a task worktree.',
    );
  }
}

export class OpenSpecPreflightService {
  constructor(private readonly cli: OpenSpecCliAdapter) {}

  async run(
    project: Project,
    input: OpenSpecPreflightInput,
  ): Promise<OpenSpecPreflightResult> {
    const projectRoot = canonicalProjectRoot(project);
    const rootKind: OpenSpecRootKind = input.rootKind === 'store' ? 'store' : 'project';
    const schemaName = identifier(input.schemaName, 'spec-driven', 'Schema name');
    const changeName = input.changeName?.trim()
      ? identifier(input.changeName, '', 'Change name')
      : undefined;
    const storeId = rootKind === 'store'
      ? identifier(input.storeId, '', 'Store ID')
      : undefined;
    const startAction = input.startAction ?? 'new';
    if (!['new', 'propose', 'explore'].includes(startAction)) {
      throw new Error('Unsupported OpenSpec start Action.');
    }

    const checks: OpenSpecPreflightCheck[] = [];
    const baseScope: OpenSpecCliScope = {
      cwd: projectRoot,
      rootKind,
      ...(storeId ? { storeId } : {}),
    };

    const [version, rawStores] = await Promise.all([
      this.cli.version(baseScope),
      this.cli.storeList<unknown>({ cwd: projectRoot }),
    ]);
    checks.push(check(
      'version',
      version === OPEN_SPEC_VERSION,
      `OpenSpec ${version} is available from the application-pinned runtime.`,
    ));
    checks.push(check(
      'project-root',
      true,
      `Project root "${basename(projectRoot)}" resolved successfully.`,
    ));

    const storeRecords = (
      rawStores &&
      typeof rawStores === 'object' &&
      !Array.isArray(rawStores) &&
      Array.isArray((rawStores as RawStoreList).stores)
    )
      ? (rawStores as RawStoreList).stores ?? []
      : [];
    const registeredStores = storeRecords
      .map((store) => typeof store.id === 'string' ? store.id : null)
      .filter((id): id is string => Boolean(id));

    let officialRoot = projectRoot;
    let storeAvailable = rootKind !== 'store';
    if (rootKind === 'store') {
      storeAvailable = Boolean(storeId && registeredStores.includes(storeId));
      if (storeAvailable) {
        const context = await this.cli.context<RawContext>(baseScope);
        const contextRoot = context.root?.path;
        if (typeof contextRoot !== 'string' || !contextRoot.trim()) {
          throw new Error(`Registered OpenSpec Store "${storeId}" did not resolve an official root.`);
        }
        officialRoot = realpathSync.native(resolve(contextRoot));
        if (!statSync(officialRoot).isDirectory()) {
          throw new Error(`Registered OpenSpec Store "${storeId}" does not resolve to a directory.`);
        }
      }
      checks.push(check(
        'store',
        storeAvailable,
        storeAvailable
          ? `Registered OpenSpec Store "${storeId}" resolved successfully.`
          : `OpenSpec Store "${storeId}" is not registered on this machine.`,
      ));
    }

    const schemaScope: OpenSpecCliScope = {
      ...baseScope,
      cwd: officialRoot,
    };
    const rawSchemas = await this.cli.schemas<unknown>(schemaScope);
    const availableSchemas = Array.isArray(rawSchemas)
      ? rawSchemas
        .map((schema) => (
          schema && typeof schema === 'object' && typeof (schema as RawSchema).name === 'string'
            ? (schema as { name: string }).name
            : null
        ))
        .filter((name): name is string => Boolean(name))
      : [];
    const schemaAvailable = availableSchemas.includes(schemaName);
    if (schemaAvailable) {
      await this.cli.templates<unknown>(schemaScope, schemaName);
    }
    checks.push(check(
      'schema',
      schemaAvailable,
      schemaAvailable
        ? `Schema "${schemaName}" and its official templates resolved successfully.`
        : `Schema "${schemaName}" is not available to OpenSpec ${OPEN_SPEC_VERSION}.`,
    ));

    if (input.useWorktree) {
      checks.push(gitWorktreeCheck(projectRoot));
    }

    const initialized = rootKind === 'store'
      ? storeAvailable && existsSync(join(officialRoot, 'openspec'))
      : existsSync(join(projectRoot, 'openspec'));
    let changeExists = false;
    if ((initialized || rootKind === 'store') && storeAvailable) {
      const rawChanges = await this.cli.list<RawChangeList>(baseScope);
      changeExists = Boolean(
        changeName &&
        rawChanges.changes?.some((candidate) => candidate.name === changeName),
      );
    }

    const changeConflicts = Boolean(
      changeName &&
      changeExists &&
      (startAction === 'new' || startAction === 'propose'),
    );
    checks.push(check(
      'change',
      !changeConflicts,
      changeConflicts
        ? `Change "${changeName}" already exists; New and Propose cannot recreate it.`
        : changeName
          ? changeExists
            ? `Existing change "${changeName}" can be used by Explore.`
            : `Change identifier "${changeName}" is available.`
          : 'OpenSpec will derive or request a change identifier through the official workflow.',
      changeConflicts ? 'error' : 'info',
    ));

    const valid = checks.every((entry) => entry.ok || entry.severity !== 'error');
    return {
      valid,
      openSpecVersion: OPEN_SPEC_VERSION,
      rootKind,
      rootLabel: rootKind === 'store' ? `Store: ${storeId}` : basename(projectRoot),
      initialized,
      schemaName,
      availableSchemas,
      registeredStores,
      changeExists,
      checks,
    };
  }
}

export const __openSpecPreflightTestUtils = {
  identifier,
  gitWorktreeCheck,
};
