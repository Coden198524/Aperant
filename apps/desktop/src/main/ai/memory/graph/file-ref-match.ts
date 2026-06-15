export const GRAPH_FILE_REF_MATCH_SQL =
  getGraphFileReferenceMatchSql('je.value');

export function getGraphFileReferenceMatchSql(expression: string): string {
  return `LOWER(REPLACE(REPLACE(REPLACE(TRIM(${expression}), char(92), '/'), '//', '/'), '//', '/'))`;
}

export function getGraphFileReferenceMatchArgs(
  filePaths: readonly string[],
): string[] {
  const seen = new Set<string>();
  const matchArgs: string[] = [];
  for (const filePath of filePaths) {
    const normalized = normalizeGraphFileReferenceMatchKey(filePath);
    if (!normalized) {
      continue;
    }

    for (const variant of getGraphFileReferenceMatchVariants(normalized)) {
      if (seen.has(variant)) {
        continue;
      }
      seen.add(variant);
      matchArgs.push(variant);
    }
  }
  return matchArgs;
}

function normalizeGraphFileReferenceMatchKey(filePath: string): string {
  return filePath
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .trim()
    .toLowerCase();
}

function getGraphFileReferenceMatchVariants(filePath: string): string[] {
  const variants = [filePath];
  if (!filePath.endsWith('/')) {
    variants.push(`${filePath}/`);
  }

  if (
    !filePath.startsWith('/') &&
    !/^[a-z][a-z0-9+.-]*:\//i.test(filePath)
  ) {
    variants.push(`./${filePath}`);
    if (!filePath.endsWith('/')) {
      variants.push(`./${filePath}/`);
    }
  }

  return variants;
}
