export interface AutocodeWorkDependencyItem {
  id: string;
  status?: string;
  dependsOn?: readonly string[];
}

export type AutocodeWorkDependencyIssueType = 'missing' | 'self' | 'cycle' | 'duplicate';

export interface AutocodeWorkDependencyIssue {
  type: AutocodeWorkDependencyIssueType;
  itemId: string;
  dependencyId?: string;
  cycle?: string[];
  message: string;
}

export interface AutocodeWorkDependencyBlockedItem<T extends AutocodeWorkDependencyItem> {
  item: T;
  unresolvedDependencies: string[];
  issues: AutocodeWorkDependencyIssue[];
}

export interface AutocodeWorkDependencyAnalysis<T extends AutocodeWorkDependencyItem> {
  runnable: T[];
  blocked: Array<AutocodeWorkDependencyBlockedItem<T>>;
  issues: AutocodeWorkDependencyIssue[];
}

export interface AnalyzeAutocodeWorkDependenciesOptions {
  statusById?: ReadonlyMap<string, string>;
  completedStatus?: string;
}

export function normalizeAutocodeWorkDependencyIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(
      value
        .map((item) => {
          if (typeof item === 'string') return item.trim();
          if (typeof item === 'number' && Number.isFinite(item)) return String(item);
          return '';
        })
        .filter((item) => item && !isNoneDependencyToken(item))
        .filter(Boolean),
    );
  }

  if (typeof value === 'string') {
    return uniqueStrings(
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item && !isNoneDependencyToken(item))
        .filter(Boolean),
    );
  }

  return [];
}

function isNoneDependencyToken(value: string): boolean {
  return /^(none|no dependencies?|n\/a|na|nil|null|无|无依赖|没有|没有依赖)$/i.test(value.trim());
}

export function buildAutocodeWorkDependencyStatusMap(
  items: readonly AutocodeWorkDependencyItem[],
): Map<string, string> {
  const statusById = new Map<string, string>();
  for (const item of items) {
    if (item.id) {
      statusById.set(item.id, item.status ?? '');
    }
  }
  return statusById;
}

export function areAutocodeWorkDependenciesSatisfied(
  item: AutocodeWorkDependencyItem,
  statusById: ReadonlyMap<string, string>,
  completedStatus = 'completed',
): boolean {
  return getAutocodeUnresolvedWorkDependencies(item, statusById, completedStatus).length === 0;
}

export function getAutocodeUnresolvedWorkDependencies(
  item: AutocodeWorkDependencyItem,
  statusById: ReadonlyMap<string, string>,
  completedStatus = 'completed',
): string[] {
  return normalizeAutocodeWorkDependencyIds(item.dependsOn)
    .filter((dependencyId) => dependencyId === item.id || statusById.get(dependencyId) !== completedStatus);
}

export function analyzeAutocodeWorkDependencies<T extends AutocodeWorkDependencyItem>(
  items: readonly T[],
  options: AnalyzeAutocodeWorkDependenciesOptions = {},
): AutocodeWorkDependencyAnalysis<T> {
  const completedStatus = options.completedStatus ?? 'completed';
  const statusById = options.statusById ?? buildAutocodeWorkDependencyStatusMap(items);
  const issues = collectDependencyIssues(items, statusById);
  const issuesByItemId = groupIssuesByItemId(issues);
  const runnable: T[] = [];
  const blocked: Array<AutocodeWorkDependencyBlockedItem<T>> = [];

  for (const item of items) {
    const unresolvedDependencies = getAutocodeUnresolvedWorkDependencies(item, statusById, completedStatus);
    const itemIssues = issuesByItemId.get(item.id) ?? [];
    if (unresolvedDependencies.length === 0 && itemIssues.length === 0) {
      runnable.push(item);
    } else {
      blocked.push({ item, unresolvedDependencies, issues: itemIssues });
    }
  }

  return { runnable, blocked, issues };
}

export function describeAutocodeWorkDependencyBlocker<T extends AutocodeWorkDependencyItem>(
  blocked: AutocodeWorkDependencyBlockedItem<T>,
  statusById?: ReadonlyMap<string, string>,
): string {
  const cycle = blocked.issues.find((issue) => issue.type === 'cycle')?.cycle;
  if (cycle && cycle.length > 1) {
    return `${blocked.item.id} blocked by dependency cycle ${cycle.join(' -> ')}`;
  }

  const issueMessages = blocked.issues
    .filter((issue) => issue.type === 'missing' || issue.type === 'self' || issue.type === 'duplicate')
    .map((issue) => issue.message);
  if (issueMessages.length > 0) {
    return `${blocked.item.id} blocked: ${issueMessages.join('; ')}`;
  }

  const unresolved = blocked.unresolvedDependencies.map((dependencyId) => {
    const status = statusById?.get(dependencyId);
    return status ? `${dependencyId} (${status})` : `${dependencyId} (missing)`;
  });
  return `${blocked.item.id} waits for ${unresolved.join(', ') || 'unknown dependency'}`;
}

export function describeAutocodeWorkDependencyBlockers<T extends AutocodeWorkDependencyItem>(
  blockedItems: readonly AutocodeWorkDependencyBlockedItem<T>[],
  statusById?: ReadonlyMap<string, string>,
): string {
  return blockedItems
    .map((blocked) => describeAutocodeWorkDependencyBlocker(blocked, statusById))
    .join('; ');
}

function collectDependencyIssues<T extends AutocodeWorkDependencyItem>(
  items: readonly T[],
  statusById: ReadonlyMap<string, string>,
): AutocodeWorkDependencyIssue[] {
  const issues: AutocodeWorkDependencyIssue[] = [];
  issues.push(...collectDuplicateIdIssues(items));

  for (const item of items) {
    for (const dependencyId of normalizeAutocodeWorkDependencyIds(item.dependsOn)) {
      if (dependencyId === item.id) {
        issues.push({
          type: 'self',
          itemId: item.id,
          dependencyId,
          message: `${item.id} cannot depend on itself`,
        });
      } else if (!statusById.has(dependencyId)) {
        issues.push({
          type: 'missing',
          itemId: item.id,
          dependencyId,
          message: `${item.id} depends on missing work item ${dependencyId}`,
        });
      }
    }
  }

  issues.push(...collectCycleIssues(items));
  return issues;
}

function collectDuplicateIdIssues<T extends AutocodeWorkDependencyItem>(
  items: readonly T[],
): AutocodeWorkDependencyIssue[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.id) {
      continue;
    }
    counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  }

  const duplicateIds = new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id),
  );
  if (duplicateIds.size === 0) {
    return [];
  }

  return [...duplicateIds].map((itemId) => ({
    type: 'duplicate' as const,
    itemId,
    message: `Duplicate work item id ${itemId}`,
  }));
}

function collectCycleIssues<T extends AutocodeWorkDependencyItem>(
  items: readonly T[],
): AutocodeWorkDependencyIssue[] {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];
  const seenCycleKeys = new Set<string>();
  const issues: AutocodeWorkDependencyIssue[] = [];

  const visit = (itemId: string) => {
    if (visiting.has(itemId)) {
      const cycleStart = stack.indexOf(itemId);
      if (cycleStart >= 0) {
        const cycle = [...stack.slice(cycleStart), itemId];
        const key = canonicalCycleKey(cycle);
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          for (const cycleItemId of cycle.slice(0, -1)) {
            issues.push({
              type: 'cycle',
              itemId: cycleItemId,
              cycle,
              message: `Dependency cycle detected: ${cycle.join(' -> ')}`,
            });
          }
        }
      }
      return;
    }

    if (visited.has(itemId)) {
      return;
    }

    const item = itemById.get(itemId);
    if (!item) {
      return;
    }

    visiting.add(itemId);
    stack.push(itemId);

    for (const dependencyId of normalizeAutocodeWorkDependencyIds(item.dependsOn)) {
      if (dependencyId !== itemId && itemById.has(dependencyId)) {
        visit(dependencyId);
      }
    }

    stack.pop();
    visiting.delete(itemId);
    visited.add(itemId);
  };

  for (const item of items) {
    visit(item.id);
  }

  return issues;
}

function groupIssuesByItemId(issues: readonly AutocodeWorkDependencyIssue[]): Map<string, AutocodeWorkDependencyIssue[]> {
  const issuesByItemId = new Map<string, AutocodeWorkDependencyIssue[]>();
  for (const issue of issues) {
    const existing = issuesByItemId.get(issue.itemId) ?? [];
    existing.push(issue);
    issuesByItemId.set(issue.itemId, existing);
  }
  return issuesByItemId;
}

function canonicalCycleKey(cycle: readonly string[]): string {
  const body = cycle.slice(0, -1);
  if (body.length === 0) {
    return '';
  }
  const rotations = body.map((_, index) => [
    ...body.slice(index),
    ...body.slice(0, index),
  ].join('>'));
  return rotations.sort()[0] ?? body.join('>');
}

function uniqueStrings(items: readonly string[]): string[] {
  return [...new Set(items)];
}
