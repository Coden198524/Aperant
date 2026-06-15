const MAX_MEMORY_MODULE_FILTERS = 12;
const MAX_MEMORY_MODULE_FILTER_CHARS = 96;

export function normalizeMemoryModuleFilters(
  modules: readonly string[] | undefined,
): string[] {
  if (!modules) {
    return [];
  }

  const seen = new Set<string>();
  const normalizedModules: string[] = [];
  for (const moduleName of modules) {
    const normalized = moduleName.replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > MAX_MEMORY_MODULE_FILTER_CHARS) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedModules.push(normalized);
    if (normalizedModules.length >= MAX_MEMORY_MODULE_FILTERS) {
      break;
    }
  }

  return normalizedModules;
}
