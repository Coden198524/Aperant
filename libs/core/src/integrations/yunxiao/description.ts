import { sanitizeText, sanitizeUrl } from '../../security/sanitize.js';

const DESCRIPTION_MAX_LENGTH = 50000;

const BLOCK_TAGS = new Set([
  'article',
  'section',
  'div',
  'p',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'blockquote',
  'pre',
  'br'
]);

interface ParsedDescriptionPayload {
  plainText?: string;
  htmlValue?: string;
  jsonMLValue?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_match, token: string) => {
    const normalized = token.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos' || normalized === '#39') return '\'';
    if (normalized === 'nbsp') return ' ';

    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      if (Number.isFinite(codePoint)) {
        return String.fromCodePoint(codePoint);
      }
      return '';
    }

    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      if (Number.isFinite(codePoint)) {
        return String.fromCodePoint(codePoint);
      }
      return '';
    }

    return '';
  });
}

function collapseMarkdownWhitespace(input: string): string {
  return input
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]+>/g, ''));
}

function parseDescriptionPayload(raw: unknown): ParsedDescriptionPayload {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};

    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        return {
          plainText: typeof parsed['textValue'] === 'string' ? parsed['textValue'] : undefined,
          htmlValue: typeof parsed['htmlValue'] === 'string' ? parsed['htmlValue'] : undefined,
          jsonMLValue: parsed['jsonMLValue']
        };
      }
      if (Array.isArray(parsed)) {
        return { jsonMLValue: parsed };
      }
    } catch {
      // Treat as plain string.
    }

    return { plainText: trimmed };
  }

  if (Array.isArray(raw)) {
    return { jsonMLValue: raw };
  }

  if (isRecord(raw)) {
    const plainText = typeof raw['textValue'] === 'string'
      ? raw['textValue']
      : typeof raw['value'] === 'string'
        ? raw['value']
        : typeof raw['description'] === 'string'
          ? raw['description']
          : undefined;

    return {
      plainText,
      htmlValue: typeof raw['htmlValue'] === 'string' ? raw['htmlValue'] : undefined,
      jsonMLValue: raw['jsonMLValue']
    };
  }

  return {};
}

function normalizeCandidateText(input: string | undefined): string {
  if (!input) return '';
  return sanitizeText(decodeHtmlEntities(input), DESCRIPTION_MAX_LENGTH, true);
}

function htmlToMarkdownText(html: string): string {
  let md = html;

  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');

  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_match, content: string) => {
    let index = 0;
    return `${content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_liMatch: string, text: string) => {
      index += 1;
      return `${index}. ${stripTags(text).trim()}\n`;
    })}\n`;
  });

  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_match, content: string) => {
    return `${content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_liMatch: string, text: string) => {
      return `- ${stripTags(text).trim()}\n`;
    })}\n`;
  });

  md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**');
  md = md.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
  md = md.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*');
  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
  md = md.replace(/<tt[^>]*>(.*?)<\/tt>/gi, '`$1`');

  md = md.replace(
    /<a[^>]*href=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href1: string, href2: string, href3: string, label: string) => {
      const href = sanitizeUrl((href1 || href2 || href3 || '').trim());
      const text = stripTags(label).trim() || href;
      if (!href) return text;
      return `[${text}](${href})`;
    }
  );

  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  md = md.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '$1\n\n');
  md = md.replace(/<article[^>]*>([\s\S]*?)<\/article>/gi, '$1\n\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<hr\s*\/?>/gi, '---\n\n');

  // Remove images from body text; they are appended in a dedicated Images section.
  md = md.replace(/<img\b[^>]*>/gi, '\n');

  while (/<[^>]+>/.test(md)) {
    md = md.replace(/<[^>]+>/g, '');
  }

  return collapseMarkdownWhitespace(decodeHtmlEntities(md));
}

function getUniqueImageUrlsFromHtml(html: string): string[] {
  const urls = new Set<string>();
  const imgTagRegex = /<img\b[^>]*>/gi;
  let match = imgTagRegex.exec(html);
  while (match) {
    const tag = match[0];
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const src = (srcMatch?.[1] || srcMatch?.[2] || srcMatch?.[3] || '').trim();
    const safe = sanitizeUrl(src);
    if (safe) urls.add(safe);
    match = imgTagRegex.exec(html);
  }
  return Array.from(urls);
}

function collectJsonMlTextAndImages(
  node: unknown,
  textParts: string[],
  imageUrls: Set<string>,
  parentTag?: string
): void {
  if (typeof node === 'string') {
    const clean = sanitizeText(decodeHtmlEntities(node), 2000, true);
    if (clean) {
      textParts.push(clean);
    }
    return;
  }

  if (!Array.isArray(node)) return;

  const tag = typeof node[0] === 'string' ? node[0].toLowerCase() : parentTag;
  let startIndex = 0;
  if (typeof node[0] === 'string') {
    startIndex = 1;
  }

  if (node.length > startIndex && isRecord(node[startIndex])) {
    const attrs = node[startIndex] as Record<string, unknown>;
    if (tag === 'img') {
      const src = typeof attrs['src'] === 'string' ? attrs['src'] : '';
      const safe = sanitizeUrl(src);
      if (safe) imageUrls.add(safe);
    }
    startIndex += 1;
  }

  for (let i = startIndex; i < node.length; i += 1) {
    collectJsonMlTextAndImages(node[i], textParts, imageUrls, tag);
  }

  if (tag && BLOCK_TAGS.has(tag)) {
    textParts.push('\n');
  }
}

function containsHtml(input: string): boolean {
  return /<\s*[a-zA-Z][^>]*>/.test(input);
}

export function normalizeYunxiaoDescriptionValue(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed || undefined;
  }

  if (raw === null || raw === undefined) return undefined;

  if (typeof raw === 'object') {
    try {
      const encoded = JSON.stringify(raw);
      const trimmed = encoded.trim();
      return trimmed || undefined;
    } catch {
      return undefined;
    }
  }

  const asString = String(raw).trim();
  return asString || undefined;
}

export function formatYunxiaoDescriptionContent(raw: unknown): string {
  const payload = parseDescriptionPayload(raw);

  const imageUrls = new Set<string>();
  let markdownText = '';

  if (payload.htmlValue) {
    markdownText = htmlToMarkdownText(payload.htmlValue);
    for (const url of getUniqueImageUrlsFromHtml(payload.htmlValue)) {
      imageUrls.add(url);
    }
  }

  let jsonMlText = '';
  if (payload.jsonMLValue !== undefined) {
    const textParts: string[] = [];
    collectJsonMlTextAndImages(payload.jsonMLValue, textParts, imageUrls);
    jsonMlText = collapseMarkdownWhitespace(textParts.join(' '));
  }

  const plainText = normalizeCandidateText(payload.plainText);
  let descriptionText = markdownText || jsonMlText;

  if (!descriptionText && plainText) {
    descriptionText = containsHtml(plainText) ? htmlToMarkdownText(plainText) : plainText;
    if (containsHtml(plainText)) {
      for (const url of getUniqueImageUrlsFromHtml(plainText)) {
        imageUrls.add(url);
      }
    }
  }

  if (!descriptionText) {
    descriptionText = 'No description provided.';
  }

  const images = Array.from(imageUrls).filter(url => !descriptionText.includes(url));
  if (images.length === 0) {
    return descriptionText;
  }

  const imageSection = images
    .map((url, index) => `![Yunxiao Image ${index + 1}](${url})`)
    .join('\n\n');

  return `${descriptionText}\n\n## Images\n\n${imageSection}`;
}
