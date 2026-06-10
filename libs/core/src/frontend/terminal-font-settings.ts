export const AUTOCODE_FONT_SIZE_MIN = 10;
export const AUTOCODE_FONT_SIZE_MAX = 24;
export const AUTOCODE_FONT_SIZE_STEP = 1;

export const AUTOCODE_FONT_WEIGHT_MIN = 100;
export const AUTOCODE_FONT_WEIGHT_MAX = 900;
export const AUTOCODE_FONT_WEIGHT_STEP = 100;

export const AUTOCODE_LINE_HEIGHT_MIN = 1.0;
export const AUTOCODE_LINE_HEIGHT_MAX = 2.0;
export const AUTOCODE_LINE_HEIGHT_STEP = 0.1;

export const AUTOCODE_LETTER_SPACING_MIN = -2;
export const AUTOCODE_LETTER_SPACING_MAX = 5;
export const AUTOCODE_LETTER_SPACING_STEP = 0.5;

export const AUTOCODE_SCROLLBACK_MIN = 1000;
export const AUTOCODE_SCROLLBACK_MAX = 100000;
export const AUTOCODE_SCROLLBACK_STEP = 1000;

export const AUTOCODE_MAX_FONT_FAMILY_LENGTH = 10;
export const AUTOCODE_MAX_IMPORT_FILE_SIZE = 10 * 1024;

export const AUTOCODE_VALID_CURSOR_STYLES = ['block', 'underline', 'bar'] as const;
export type AutocodeCursorStyle = typeof AUTOCODE_VALID_CURSOR_STYLES[number];

export const AUTOCODE_HEX_COLOR_REGEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

export function isValidAutocodeFontSize(value: number): boolean {
  return value >= AUTOCODE_FONT_SIZE_MIN && value <= AUTOCODE_FONT_SIZE_MAX;
}

export function isValidAutocodeFontWeight(value: number): boolean {
  return (
    value >= AUTOCODE_FONT_WEIGHT_MIN &&
    value <= AUTOCODE_FONT_WEIGHT_MAX &&
    value % AUTOCODE_FONT_WEIGHT_STEP === 0
  );
}

export function isValidAutocodeLineHeight(value: number): boolean {
  return value >= AUTOCODE_LINE_HEIGHT_MIN && value <= AUTOCODE_LINE_HEIGHT_MAX;
}

export function isValidAutocodeLetterSpacing(value: number): boolean {
  return value >= AUTOCODE_LETTER_SPACING_MIN && value <= AUTOCODE_LETTER_SPACING_MAX;
}

export function isValidAutocodeScrollback(value: number): boolean {
  return value >= AUTOCODE_SCROLLBACK_MIN && value <= AUTOCODE_SCROLLBACK_MAX;
}

export function isValidAutocodeCursorStyle(value: string): value is AutocodeCursorStyle {
  return AUTOCODE_VALID_CURSOR_STYLES.includes(value as AutocodeCursorStyle);
}

export function isValidAutocodeHexColor(value: string): boolean {
  return AUTOCODE_HEX_COLOR_REGEX.test(value);
}

export function isValidAutocodeFontFamily(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= AUTOCODE_MAX_FONT_FAMILY_LENGTH &&
    value.every((item) => typeof item === 'string' && item.length > 0)
  );
}
