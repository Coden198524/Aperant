const OPEN_STATUS_TOKENS = [
  'open',
  'todo',
  'new',
  'active',
  'inprogress',
  'processing',
  'pending',
  '待处理',
  '处理中',
  '进行中',
  '开发中',
  '未开始',
];

const CLOSED_STATUS_TOKENS = [
  'closed',
  'resolved',
  'done',
  'completed',
  'complete',
  'fixed',
  'canceled',
  'cancelled',
  '已关闭',
  '关闭',
  '已解决',
  '解决',
  '已完成',
  '完成',
  '已修复',
  '修复',
  '已取消',
  '取消',
];

function normalizeAutocodeYunxiaoStatus(value?: string): string {
  return (value || '').trim().toLowerCase().replace(/\s+/g, '');
}

export function isClosedAutocodeYunxiaoStatus(status?: string): boolean {
  const normalized = normalizeAutocodeYunxiaoStatus(status);
  if (!normalized) {
    return false;
  }

  if (OPEN_STATUS_TOKENS.some((token) => normalized.includes(normalizeAutocodeYunxiaoStatus(token)))) {
    return false;
  }

  return CLOSED_STATUS_TOKENS.some((token) => normalized.includes(normalizeAutocodeYunxiaoStatus(token)));
}
