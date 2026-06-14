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

const GBK_UTF8_PUNCTUATION_MOJIBAKE_PATTERNS = [
  '鈥檒',
  '鈥檓',
  '鈥檙',
  '鈥檚',
  '鈥檛',
  '鈥檝',
] as const;

const COMMON_UTF8_AS_GBK_CHINESE_MOJIBAKE_PATTERNS = [
  '\u7487\u5b58\u69d1', // 说明
  '\u6924\u572d\u6d30', // 项目
  '\u9422\u71b8\u579a', // 生成
  '\u6d93\ue15f\u6783', // 中文
  '\u9350\u546d\ue190', // 内容
  '\u9422\u3126\u57db', // 用户
  '\u6d60\uff47\u721c', // 代码
  '\u95b0\u5d87\u7586', // 配置
  '\u5bee\u20ac\u6fee', // 开始
  '\u7039\u5c7e\u579a', // 完成
  '\u59dd\uff45\u6e6a', // 正在
  '\u9352\u6d99\u5270', // 创意
  '\u6d60\u8bf2\u59df', // 任务
  '\u74ba\ue21c\u568e', // 路线图
  '\u690b\u5ea8\u6ad3', // 风险
  '\u8930\u64b3\u58a0', // 当前
  '\u93c2\u56e6\u6b22', // 文件
  '\u9352\u55d8\u703d', // 分析
  '\u7039\u70b5\u5e47', // 实现
  '\u6960\u5c83\u7609', // 验证
  '\u93cb\u8235\u702f', // 架构
  '\u5a34\u4f7a\u25bc', // 流程
  '\u9429\ue1bd\u7223', // 目标
  '\u6d5c\u0443\u6427', // 产品
  '\u6d93\u660f\ue6e6', // 主要
  '\u9356\u546d\u60c8', // 包含
  '\u6748\u64b3\u56ad', // 输出
  '\u6dc7\ue1bd\u657c', // 修改
  '\u6dc7\ue1bc\ue632', // 修复
  '\u6fb6\u52ed\u608a', // 处理
  '\u9354\u72ba\u6d47', // 加载
  '\u6fb6\u8fab\u89e6', // 失败
  '\u7487\ue161\u2588', // 语言
  '\u7ee0\u20ac\u6d63', // 简体
  '\u9354\u71bb\u5158', // 功能
  '\u93c1\u7248\u5d41', // 数据
  '\u9429\ue1bc\u7d8d', // 目录
  '\u7eef\u8364\u7cba', // 系统
  '\u93c8\u5d85\u59df', // 服务
  '\u5bb8\u30e4\u7d94', // 工作
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
  const separatorRepairedText = repairDenseInjectedFullStopText(text);
  if (
    !separatorRepairedText ||
    scoreMojibakePatternDamage(separatorRepairedText) < 2 ||
    scoreEncodingDamage(separatorRepairedText) < 2
  ) {
    return separatorRepairedText;
  }

  let candidate = separatorRepairedText;
  try {
    candidate = normalizeLossyMojibakePunctuation(
      iconvLite.decode(iconvLite.encode(separatorRepairedText, 'gbk'), 'utf8'),
    );
  } catch {
    return separatorRepairedText;
  }

  return shouldPreferEncodingCandidate(separatorRepairedText, candidate) ? candidate : separatorRepairedText;
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
  if (addsDenseInjectedFullStops(original, candidate)) {
    return false;
  }

  const originalScore = scoreEncodingDamage(original);
  const candidateScore = scoreEncodingDamage(candidate);
  return originalScore >= 2 && candidateScore + 1 < originalScore;
}

function scoreEncodingDamage(text: string): number {
  let score = countReplacementCharacters(text) * 12;
  return score + scoreMojibakePatternDamage(text);
}

function scoreMojibakePatternDamage(text: string): number {
  let score = 0;
  for (const pattern of MOJIBAKE_PATTERNS) {
    let index = text.indexOf(pattern);
    while (index >= 0) {
      score += pattern.length;
      index = text.indexOf(pattern, index + pattern.length);
    }
  }
  for (const pattern of GBK_UTF8_PUNCTUATION_MOJIBAKE_PATTERNS) {
    let index = text.indexOf(pattern);
    while (index >= 0) {
      score += pattern.length;
      index = text.indexOf(pattern, index + pattern.length);
    }
  }
  for (const pattern of COMMON_UTF8_AS_GBK_CHINESE_MOJIBAKE_PATTERNS) {
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

function repairDenseInjectedFullStopText(text: string): string {
  if (!hasDenseInjectedFullStopDamage(text)) {
    return text;
  }

  return text.replace(/。(?=[^。])/g, '');
}

function addsDenseInjectedFullStops(original: string, candidate: string): boolean {
  const originalCount = countInjectedFullStopSeparators(original);
  const candidateCount = countInjectedFullStopSeparators(candidate);
  return candidateCount - originalCount >= 20 && hasDenseInjectedFullStopDamage(candidate);
}

function hasDenseInjectedFullStopDamage(text: string): boolean {
  const count = countInjectedFullStopSeparators(text);
  return count >= 20 && count * 4 >= text.length;
}

function countInjectedFullStopSeparators(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] === '。' && !/\s|。/.test(text[index + 1] ?? '')) {
      count += 1;
    }
  }
  return count;
}

function normalizeLossyMojibakePunctuation(text: string): string {
  return text.replace(/\uFFFD\?/g, '。');
}
