const MAX_SPEC_SLUG_LENGTH = 50;
const DEFAULT_SPEC_SLUG = 'task';

export function slugifySpecTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, MAX_SPEC_SLUG_LENGTH);
}

export function buildSpecId(specNumber: number, title: string, fallbackSlug = DEFAULT_SPEC_SLUG): string {
  const normalizedNumber = Number.isFinite(specNumber) && specNumber > 0 ? Math.floor(specNumber) : 1;
  const paddedNumber = String(normalizedNumber).padStart(3, '0');
  const slug = slugifySpecTitle(title) || slugifySpecTitle(fallbackSlug) || DEFAULT_SPEC_SLUG;
  return `${paddedNumber}-${slug}`;
}
