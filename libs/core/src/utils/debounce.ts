export interface AutocodeDebounceOptions {
  leading?: boolean;
  trailing?: boolean;
}

export interface AutocodeDebouncedFunction<TArgs extends unknown[]> {
  fn: (...args: TArgs) => void;
  cancel: () => void;
}

export function debounceAutocode<TArgs extends unknown[], TReturn = void>(
  fn: (...args: TArgs) => TReturn,
  wait: number,
  options: AutocodeDebounceOptions = {},
): AutocodeDebouncedFunction<TArgs> {
  const { leading = false, trailing = true } = options;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastCallTime: number | null = null;
  let hasTrailingArgs = false;

  const invokeFunc = (args: TArgs) => {
    fn(...args);
  };

  const debouncedFn = (...args: TArgs): void => {
    const isFirstCall = lastCallTime === null;
    lastCallTime = Date.now();

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (leading && isFirstCall) {
      invokeFunc(args);
      hasTrailingArgs = false;
    } else {
      hasTrailingArgs = true;
    }

    if (trailing) {
      timeoutId = setTimeout(() => {
        if (hasTrailingArgs) {
          invokeFunc(args);
        }
        lastCallTime = null;
        timeoutId = null;
        hasTrailingArgs = false;
      }, wait);
    } else if (leading) {
      timeoutId = setTimeout(() => {
        lastCallTime = null;
        timeoutId = null;
      }, wait);
    } else {
      lastCallTime = null;
    }
  };

  const cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    lastCallTime = null;
    hasTrailingArgs = false;
  };

  return { fn: debouncedFn, cancel };
}

export { debounceAutocode as debounce };
