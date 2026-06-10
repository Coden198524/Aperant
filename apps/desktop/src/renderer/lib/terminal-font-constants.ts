/**
 * Constants for terminal font settings validation and constraints
 * Used in both UI components and store validation
 */

import {
  AUTOCODE_FONT_SIZE_MAX,
  AUTOCODE_FONT_SIZE_MIN,
  AUTOCODE_FONT_SIZE_STEP,
  AUTOCODE_FONT_WEIGHT_MAX,
  AUTOCODE_FONT_WEIGHT_MIN,
  AUTOCODE_FONT_WEIGHT_STEP,
  AUTOCODE_HEX_COLOR_REGEX,
  AUTOCODE_LETTER_SPACING_MAX,
  AUTOCODE_LETTER_SPACING_MIN,
  AUTOCODE_LETTER_SPACING_STEP,
  AUTOCODE_LINE_HEIGHT_MAX,
  AUTOCODE_LINE_HEIGHT_MIN,
  AUTOCODE_LINE_HEIGHT_STEP,
  AUTOCODE_MAX_FONT_FAMILY_LENGTH,
  AUTOCODE_MAX_IMPORT_FILE_SIZE,
  AUTOCODE_SCROLLBACK_MAX,
  AUTOCODE_SCROLLBACK_MIN,
  AUTOCODE_SCROLLBACK_STEP,
  AUTOCODE_VALID_CURSOR_STYLES,
  isValidAutocodeCursorStyle,
  isValidAutocodeFontFamily,
  isValidAutocodeFontSize,
  isValidAutocodeFontWeight,
  isValidAutocodeHexColor,
  isValidAutocodeLetterSpacing,
  isValidAutocodeLineHeight,
  isValidAutocodeScrollback,
  type AutocodeCursorStyle,
} from '@autocode/core/frontend/terminal-font-settings';

// Font size constraints
export const FONT_SIZE_MIN = AUTOCODE_FONT_SIZE_MIN;
export const FONT_SIZE_MAX = AUTOCODE_FONT_SIZE_MAX;
export const FONT_SIZE_STEP = AUTOCODE_FONT_SIZE_STEP;

// Font weight constraints
export const FONT_WEIGHT_MIN = AUTOCODE_FONT_WEIGHT_MIN;
export const FONT_WEIGHT_MAX = AUTOCODE_FONT_WEIGHT_MAX;
export const FONT_WEIGHT_STEP = AUTOCODE_FONT_WEIGHT_STEP;

// Line height constraints
export const LINE_HEIGHT_MIN = AUTOCODE_LINE_HEIGHT_MIN;
export const LINE_HEIGHT_MAX = AUTOCODE_LINE_HEIGHT_MAX;
export const LINE_HEIGHT_STEP = AUTOCODE_LINE_HEIGHT_STEP;

// Letter spacing constraints
export const LETTER_SPACING_MIN = AUTOCODE_LETTER_SPACING_MIN;
export const LETTER_SPACING_MAX = AUTOCODE_LETTER_SPACING_MAX;
export const LETTER_SPACING_STEP = AUTOCODE_LETTER_SPACING_STEP;

// Scrollback constraints
export const SCROLLBACK_MIN = AUTOCODE_SCROLLBACK_MIN;
export const SCROLLBACK_MAX = AUTOCODE_SCROLLBACK_MAX;
export const SCROLLBACK_STEP = AUTOCODE_SCROLLBACK_STEP;

// Maximum font array length to prevent DoS
export const MAX_FONT_FAMILY_LENGTH = AUTOCODE_MAX_FONT_FAMILY_LENGTH;

// Maximum file size for import (10KB)
export const MAX_IMPORT_FILE_SIZE = AUTOCODE_MAX_IMPORT_FILE_SIZE;

// Valid cursor styles
export const VALID_CURSOR_STYLES = AUTOCODE_VALID_CURSOR_STYLES;
export type CursorStyle = AutocodeCursorStyle;

// Hex color regex (3-digit, 6-digit, or 8-digit)
export const HEX_COLOR_REGEX = AUTOCODE_HEX_COLOR_REGEX;

/**
 * Shared Tailwind CSS classes for range input sliders
 * Custom styling for webkit (Chrome, Safari, Edge) and Firefox thumb controls
 */
export const SLIDER_INPUT_CLASSES = [
  'w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  // Webkit (Chrome, Safari, Edge)
  '[&::-webkit-slider-thumb]:appearance-none',
  '[&::-webkit-slider-thumb]:w-4',
  '[&::-webkit-slider-thumb]:h-4',
  '[&::-webkit-slider-thumb]:rounded-full',
  '[&::-webkit-slider-thumb]:bg-primary',
  '[&::-webkit-slider-thumb]:cursor-pointer',
  '[&::-webkit-slider-thumb]:transition-all',
  '[&::-webkit-slider-thumb]:hover:scale-110',
  // Firefox
  '[&::-moz-range-thumb]:w-4',
  '[&::-moz-range-thumb]:h-4',
  '[&::-moz-range-thumb]:rounded-full',
  '[&::-moz-range-thumb]:bg-primary',
  '[&::-moz-range-thumb]:border-0',
  '[&::-moz-range-thumb]:cursor-pointer',
  '[&::-moz-range-thumb]:transition-all',
  '[&::-moz-range-thumb]:hover:scale-110',
] as const;

/**
 * Validates a font size value is within bounds
 */
export function isValidFontSize(value: number): boolean {
  return isValidAutocodeFontSize(value);
}

/**
 * Validates a font weight value is within bounds and is a multiple of 100
 * CSS font-weight only accepts 100, 200, 300... 900
 */
export function isValidFontWeight(value: number): boolean {
  return isValidAutocodeFontWeight(value);
}

/**
 * Validates a line height value is within bounds
 */
export function isValidLineHeight(value: number): boolean {
  return isValidAutocodeLineHeight(value);
}

/**
 * Validates a letter spacing value is within bounds
 */
export function isValidLetterSpacing(value: number): boolean {
  return isValidAutocodeLetterSpacing(value);
}

/**
 * Validates a scrollback value is within bounds
 */
export function isValidScrollback(value: number): boolean {
  return isValidAutocodeScrollback(value);
}

/**
 * Validates a cursor style is one of the valid options
 */
export function isValidCursorStyle(value: string): value is CursorStyle {
  return isValidAutocodeCursorStyle(value);
}

/**
 * Validates a hex color string
 */
export function isValidHexColor(value: string): boolean {
  return isValidAutocodeHexColor(value);
}

/**
 * Validates font family array
 */
export function isValidFontFamily(value: unknown): value is string[] {
  return isValidAutocodeFontFamily(value);
}
