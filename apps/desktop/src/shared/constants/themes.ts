/**
 * Theme constants
 * The app exposes one light theme and one dark theme.
 */

import type { ColorThemeDefinition } from '../types/settings';

// ============================================
// Color Themes
// ============================================

/**
 * Backwards-compatible theme list for persisted settings that still include
 * colorTheme. The settings UI no longer exposes color palette selection.
 */
export const COLOR_THEMES: ColorThemeDefinition[] = [
  {
    id: 'default',
    name: 'Autocode',
    description: 'Mature neutral light and low-glare dark interface',
    previewColors: { bg: '#F6F8FA', accent: '#0969DA', darkBg: '#0D1117', darkAccent: '#58A6FF' }
  }
];
