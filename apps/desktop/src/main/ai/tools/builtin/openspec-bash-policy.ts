import { existsSync, realpathSync } from 'node:fs';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import { extractBashWriteFileTargets } from '@autocode/core';

export interface OpenSpecBashPolicy {
  allowedPathRoots: string[];
  allowedWritePaths: string[];
  storeId?: string;
}

const SAFE_STORE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const READ_ONLY_MUTATION_PATTERN =
  /(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|rmdir|touch|truncate|install|ln|mklink)\b|\bsed\s+-[^\s]*i\b|\b(?:perl|ruby)\s+-[^\s]*i\b|\btee\b|\bgit\s+(?:-[^\s]+\s+)*(?:add|commit|checkout|switch|reset|clean|merge|rebase|cherry-pick|revert|tag|push|pull|restore)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|uninstall|update|publish)\b|\bopenspec\s+(?:init|new|archive|store\s+(?:setup|register|unregister|remove))\b|(^|[^>])>{1,2}(?!=)/i;
const NESTED_INTERPRETER_PATTERN =
  /(?:^|[;&|]\s*)(?:bash|sh|zsh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-[a-z]*c\b|\/c\b|-command\b)|(?:^|[;&|]\s*)(?:node|python\d*|perl|ruby|php)\s+(?:-[a-z]*[ce]\b|--eval\b|--command\b)|(?:^|[;&|]\s*)(?:eval|source)\b/i;
const IMPLICIT_MUTATION_PATTERN =
  /(?:^|[;&|]\s*)(?:npm|npx|pnpm|yarn|bun|bunx|cargo|go|make|cmake|gradle|mvn|dotnet|node|python\d*|perl|ruby|php)\b/i;
const STORE_MUTATION_PATTERN =
  /\bopenspec\s+store\s+(?:setup|register|unregister|remove)\b/i;
const UNPINNED_OPENSPEC_PATTERN =
  /\b(?:npx|bunx)\s+(?:--yes\s+)?(?:@fission-ai\/)?openspec\b|\b(?:npm|pnpm|yarn|bun)\s+(?:exec|dlx)\s+(?:@fission-ai\/)?openspec\b|\bnode\s+[^\r\n;&|]*openspec(?:\.js)?\b|(?:^|[\s;&|])(?:\.{0,2}[\\/]|[a-zA-Z]:[\\/])[^\s;&|]*openspec(?:\.cmd|\.js)?\b/i;
const SENSITIVE_ENV_PATH_PATTERN =
  /(?:\$(?:\{)?(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|XDG_DATA_HOME)(?:\})?|%(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|XDG_DATA_HOME)%|~[\\/])/i;
const PATH_OVERRIDE_PATTERN =
  /(?:^|[;&|]\s*)(?:export\s+)?PATH\s*=|(?:^|[;&|]\s*)set\s+["']?PATH=/i;

function pathInside(childPath: string, rootPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(childPath));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function canonicalExistingAncestor(path: string): string {
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return existsSync(cursor) ? realpathSync.native(cursor) : cursor;
}

function pathAllowed(candidate: string, roots: readonly string[]): boolean {
  const resolvedCandidate = resolve(candidate);
  const canonicalAncestor = canonicalExistingAncestor(resolvedCandidate);
  return roots.some((root) => {
    const resolvedRoot = resolve(root);
    if (!pathInside(resolvedCandidate, resolvedRoot)) return false;
    const canonicalRoot = existsSync(resolvedRoot)
      ? realpathSync.native(resolvedRoot)
      : canonicalExistingAncestor(resolvedRoot);
    return pathInside(canonicalAncestor, canonicalRoot);
  });
}

function tokenizeShell(command: string): { tokens: string[]; complete: boolean } {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const push = (): void => {
    if (current) tokens.push(current);
    current = '';
  };

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      // Preserve Windows path separators while still accepting escaped shell
      // characters. A separator followed by a normal path character remains.
      current += character;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character) || /[;&|()<>]/.test(character)) {
      push();
      continue;
    }
    current += character;
  }
  push();
  return { tokens, complete: quote === null && !escaped };
}

function normalizePathToken(token: string): string | null {
  let value = token.trim();
  if (!value || /^(?:https?|git|ssh):\/\//i.test(value) || value === '/dev/null' || /^nul$/i.test(value)) {
    return null;
  }
  const equals = value.indexOf('=');
  if (equals >= 0) value = value.slice(equals + 1);
  value = value.replace(/^[0-9]*[<>]+/, '').replace(/[,\])}]+$/, '');
  if (!value) return null;

  const windowsAbsolute = value.match(/[a-zA-Z]:[\\/].*$/)?.[0];
  if (windowsAbsolute) return windowsAbsolute;
  if (value.startsWith('\\\\')) return value;
  if (/^\/[a-zA-Z]\//.test(value) && process.platform === 'win32') {
    return `${value[1]}:${value.slice(2).replace(/\//g, '\\')}`;
  }
  return isAbsolute(value) ? value : null;
}

function storeArguments(tokens: readonly string[]): { values: string[]; malformed: boolean } {
  const values: string[] = [];
  let malformed = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--store') {
      const value = tokens[index + 1];
      if (!value || value.startsWith('-')) {
        malformed = true;
      } else {
        values.push(value);
        index += 1;
      }
    } else if (token.startsWith('--store=')) {
      const value = token.slice('--store='.length);
      if (value) values.push(value);
      else malformed = true;
    }
  }
  return { values, malformed };
}

function commandUsesPinnedOpenSpec(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:command\s+)?openspec(?:\.cmd)?(?:\s|$)/i.test(command);
}

export function getOpenSpecBashPolicyDenial(
  command: string,
  cwd: string,
  policy: OpenSpecBashPolicy,
  readOnly: boolean,
): string | null {
  if (!command.trim()) return 'OpenSpec Bash command is empty.';
  if (!policy.allowedPathRoots.length) {
    return 'OpenSpec Bash has no authorized filesystem roots.';
  }
  const parsed = tokenizeShell(command);
  if (!parsed.complete) {
    return 'OpenSpec Bash rejected an unterminated quoted command.';
  }
  if (
    command.includes('\0') ||
    /(?:^|[\s\\/])\.\.(?:[\\/]|$)/.test(command) ||
    SENSITIVE_ENV_PATH_PATTERN.test(command) ||
    /\$\(|`/.test(command)
  ) {
    return 'OpenSpec Bash rejected dynamic, home-relative, or parent-traversing paths.';
  }
  if (PATH_OVERRIDE_PATTERN.test(command)) {
    return 'OpenSpec Bash cannot replace PATH because the pinned OpenSpec shim must remain first.';
  }
  if (UNPINNED_OPENSPEC_PATTERN.test(command)) {
    return 'OpenSpec Bash can only invoke the application-pinned "openspec" command.';
  }
  if (STORE_MUTATION_PATTERN.test(command)) {
    return 'OpenSpec Actions cannot modify the machine Store registry.';
  }
  if (NESTED_INTERPRETER_PATTERN.test(command)) {
    return 'OpenSpec Bash rejected a nested shell or inline interpreter command.';
  }

  const stores = storeArguments(parsed.tokens);
  if (stores.malformed) {
    return 'OpenSpec Bash received a malformed --store argument.';
  }
  for (const store of stores.values) {
    if (!SAFE_STORE_ID.test(store) || !policy.storeId || store !== policy.storeId) {
      return `OpenSpec Bash cannot access untrusted Store "${store}".`;
    }
  }
  if (!policy.storeId && stores.values.length > 0) {
    return 'This project-local OpenSpec task cannot select a Store.';
  }

  for (const token of parsed.tokens) {
    const absolutePath = normalizePathToken(token);
    if (absolutePath && !pathAllowed(absolutePath, policy.allowedPathRoots)) {
      return `OpenSpec Bash path is outside the authorized roots: ${absolutePath}`;
    }
  }

  const writeTargets = extractBashWriteFileTargets(command);
  const mutating = writeTargets.length > 0 || READ_ONLY_MUTATION_PATTERN.test(command);
  if (readOnly && mutating) {
    return 'This OpenSpec Action is read-only; Bash commands that may mutate files are disabled.';
  }

  if (!readOnly && mutating) {
    if (!policy.allowedWritePaths.length) {
      return 'OpenSpec Bash has no authorized write roots for this Action.';
    }
    for (const target of writeTargets) {
      const resolvedTarget = isAbsolute(target) ? target : resolve(cwd, target);
      if (!pathAllowed(resolvedTarget, policy.allowedWritePaths)) {
        return `OpenSpec Bash write target is outside this Action's authorized roots: ${target}`;
      }
    }
  }

  if (
    !readOnly &&
    IMPLICIT_MUTATION_PATTERN.test(command) &&
    !commandUsesPinnedOpenSpec(command) &&
    !pathAllowed(cwd, policy.allowedWritePaths)
  ) {
    return 'OpenSpec Bash cannot run a potentially mutating command from a read-only workspace root.';
  }
  return null;
}

export const __openSpecBashPolicyTestUtils = {
  normalizePathToken,
  pathAllowed,
  storeArguments,
  tokenizeShell,
};
