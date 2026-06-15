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
    for (const normalized of normalizeMemoryModuleCandidates(moduleName)) {
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
        return normalizedModules;
      }
    }
  }

  return normalizedModules;
}

function normalizeMemoryModuleCandidates(moduleName: string): string[] {
  const lines = moduleName
    .split(/\r\n?|\n/)
    .map(normalizeMemoryModuleName)
    .filter(Boolean);
  if (lines.length > 1) {
    return lines;
  }

  const normalized = normalizeMemoryModuleName(moduleName);
  return normalized ? [normalized] : [];
}

function normalizeMemoryModuleName(moduleName: string): string {
  return moduleName.replace(/\s+/g, ' ').trim();
}
