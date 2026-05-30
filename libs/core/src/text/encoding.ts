import { TextDecoder } from 'node:util';
import iconvLite from 'iconv-lite';

const MOJIBAKE_PATTERNS = [
  '锟斤拷',
  '锛',
  '锚',
  '涓€',
  '涓�',
  '涓',
  '瀛愪',
  '换鍔',
  '浠诲姟',
  '褰撳墠',
  '鏂',
  '绋',
  '鐢',
  '寮€濮',
  '鐨',
  '缃戦',
  '椤电',
  '瀹炵幇',
  '淇勭綏',
  '娓告垙',
  '鏂瑰潡',
  '瑰潡',
  '告垙',
  '犲',
  '佸',
  '傚',
  '熷',
  '堕',
  '姝',
  '垚',
] as const;

let gb18030Decoder: TextDecoder | null | undefined;

export function decodeAutocodeCliOutputChunk(input: Uint8Array | string): string {
  const utf8Text = typeof input === 'string'
    ? input
    : Buffer.from(input).toString('utf8');
  const repairedUtf8Text = repairAutocodeChineseMojibakeText(utf8Text);

  if (typeof input === 'string') {
    return repairedUtf8Text;
  }

  const legacyText = decodeLegacyText(input);
  if (!legacyText) {
    return repairedUtf8Text;
  }

  const repairedLegacyText = repairAutocodeChineseMojibakeText(legacyText);
  return shouldPreferEncodingCandidate(repairedUtf8Text, repairedLegacyText)
    ? repairedLegacyText
    : repairedUtf8Text;
}

export function repairAutocodeChineseMojibakeText(text: string): string {
  if (!text || text.includes('\uFFFD') || scoreEncodingDamage(text) < 2) {
    return text;
  }

  let candidate = text;
  try {
    candidate = iconvLite.decode(iconvLite.encode(text, 'gbk'), 'utf8');
  } catch {
    return text;
  }

  return shouldPreferEncodingCandidate(text, candidate) ? candidate : text;
}

function decodeLegacyText(input: Uint8Array): string | null {
  if (!String(Buffer.from(input).toString('utf8')).includes('\uFFFD')) {
    return null;
  }

  try {
    if (gb18030Decoder === undefined) {
      gb18030Decoder = new TextDecoder('gb18030');
    }
    return gb18030Decoder?.decode(input) ?? null;
  } catch {
    gb18030Decoder = null;
    return null;
  }
}

function shouldPreferEncodingCandidate(original: string, candidate: string): boolean {
  if (!candidate || candidate === original) {
    return false;
  }

  const originalScore = scoreEncodingDamage(original);
  const candidateScore = scoreEncodingDamage(candidate);
  return originalScore >= 2 && candidateScore + 1 < originalScore;
}

function scoreEncodingDamage(text: string): number {
  let score = countReplacementCharacters(text) * 12;
  for (const pattern of MOJIBAKE_PATTERNS) {
    let index = text.indexOf(pattern);
    while (index >= 0) {
      score += pattern.length;
      index = text.indexOf(pattern, index + pattern.length);
    }
  }
  return score;
}

function countReplacementCharacters(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char.charCodeAt(0) === 0xfffd) {
      count += 1;
    }
  }
  return count;
}
