import { debounce as debounceCore } from '@autocode/core/utils/debounce';

export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number
): { fn: T; cancel: () => void } {
  const debounced = debounceCore(fn, ms);
  return {
    fn: debounced.fn as T,
    cancel: debounced.cancel,
  };
}
