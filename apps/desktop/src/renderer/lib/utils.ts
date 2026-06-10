import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { calculateProgress as calculateAutocodeProgress } from '@autocode/core/tasks/progress';
import {
  formatAutocodeRelativeTime,
} from '@autocode/core/frontend/task-view-model';
import {
  buildAutocodeTokenHoverTitle,
  formatAutocodeTokenCount,
  sanitizeAutocodeMarkdownForDisplay,
} from '@autocode/core/frontend/display-format';

/**
 * Utility function to merge Tailwind CSS classes
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Calculate progress percentage from subtasks
 * @param subtasks Array of subtasks with status
 * @returns Progress percentage (0-100)
 */
export function calculateProgress(subtasks: { status: string }[]): number {
  return calculateAutocodeProgress(subtasks);
}

/**
 * Format a date as a relative time string
 * @param date Date to format
 * @returns Relative time string (e.g., "2 hours ago")
 */
export function formatRelativeTime(date: Date): string {
  return formatAutocodeRelativeTime(date);
}

/**
 * Format token counts compactly for task UI.
 */
export function formatTokenCount(count: number): string {
  return formatAutocodeTokenCount(count);
}

/**
 * Build hover text for token values.
 */
export function buildTokenHoverTitle(label: string, count: number): string {
  return buildAutocodeTokenHoverTitle(label, count);
}

/**
 * Sanitize and extract plain text from markdown content.
 * Strips markdown formatting and collapses whitespace for clean display in UI.
 * @param text The text that might contain markdown
 * @param maxLength Maximum length before truncation (default: 200)
 * @returns Plain text suitable for display
 */
export function sanitizeMarkdownForDisplay(text: string, maxLength: number = 200): string {
  return sanitizeAutocodeMarkdownForDisplay(text, maxLength);
}
