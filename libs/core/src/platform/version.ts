export interface AutocodeParsedVersion {
  base: number[];
  prerelease: { type: string; num: number } | null;
}

export function parseAutocodeVersion(version: string): AutocodeParsedVersion {
  const [baseStr, prereleaseStr] = version.split('-');
  const base = baseStr.split('.').map((part) => Number.parseInt(part, 10) || 0);

  let prerelease: AutocodeParsedVersion['prerelease'] = null;
  if (prereleaseStr) {
    const match = prereleaseStr.match(/^([a-zA-Z]+)\.?(\d*)$/);
    if (match) {
      prerelease = {
        type: match[1].toLowerCase(),
        num: Number.parseInt(match[2], 10) || 0,
      };
    }
  }

  return { base, prerelease };
}

export function compareAutocodeVersions(a: string, b: string): number {
  const parsedA = parseAutocodeVersion(a);
  const parsedB = parseAutocodeVersion(b);

  const maxLen = Math.max(parsedA.base.length, parsedB.base.length);
  for (let i = 0; i < maxLen; i += 1) {
    const numA = parsedA.base[i] || 0;
    const numB = parsedB.base[i] || 0;

    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }

  if (!parsedA.prerelease && !parsedB.prerelease) return 0;
  if (!parsedA.prerelease && parsedB.prerelease) return 1;
  if (parsedA.prerelease && !parsedB.prerelease) return -1;

  const prereleaseOrder: Record<string, number> = { alpha: 0, beta: 1, rc: 2 };
  const typeA = prereleaseOrder[parsedA.prerelease!.type] ?? 1;
  const typeB = prereleaseOrder[parsedB.prerelease!.type] ?? 1;

  if (typeA > typeB) return 1;
  if (typeA < typeB) return -1;

  if (parsedA.prerelease!.num > parsedB.prerelease!.num) return 1;
  if (parsedA.prerelease!.num < parsedB.prerelease!.num) return -1;

  return 0;
}
