import { Check, Sun, Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import { Label } from '../ui/label';
import { useSettingsStore } from '../../stores/settings-store';
import type { AppSettings } from '../../../shared/types';

interface ThemeSelectorProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Theme selector component displaying the two supported app themes.
 *
 * Theme changes are applied immediately for live preview, while other settings
 * require saving to take effect.
 */
export function ThemeSelector({ settings, onSettingsChange }: ThemeSelectorProps) {
  const { t } = useTranslation('settings');
  const updateStoreSettings = useSettingsStore((state) => state.updateSettings);

  const currentMode = settings.theme === 'light' ? 'light' : 'dark';

  const handleModeChange = (mode: AppSettings['theme']) => {
    // Update local draft state
    onSettingsChange({ ...settings, theme: mode, colorTheme: 'default' });
    // Apply immediately to store for live preview (triggers App.tsx useEffect)
    updateStoreSettings({ theme: mode, colorTheme: 'default' });
  };

  const themeOptions = [
    {
      id: 'light' as const,
      label: t('theme.light', 'Light'),
      description: t('theme.lightDescription', 'Bright, neutral surfaces with a crisp blue accent.'),
      icon: Sun,
      preview: {
        background: '#F6F7F9',
        card: '#FFFFFF',
        text: '#111827',
        muted: '#D8DEE8',
        accent: '#2563EB'
      }
    },
    {
      id: 'dark' as const,
      label: t('theme.dark', 'Dark'),
      description: t('theme.darkDescription', 'Low-glare charcoal surfaces with a softer blue accent.'),
      icon: Moon,
      preview: {
        background: '#0F1115',
        card: '#171A21',
        text: '#F1F5F9',
        muted: '#2C3442',
        accent: '#60A5FA'
      }
    }
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Label className="text-sm font-medium text-foreground">{t('theme.mode', 'Theme')}</Label>
        <p className="text-sm text-muted-foreground">{t('theme.modeDescription', 'Choose one of the two built-in themes')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl pt-1">
          {themeOptions.map((option) => {
            const Icon = option.icon;
            const isSelected = currentMode === option.id;

            return (
              <button
                key={option.id}
                onClick={() => handleModeChange(option.id)}
                className={cn(
                  'relative flex min-h-[168px] flex-col gap-3 rounded-md border-2 p-4 text-left transition-all',
                  'hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/50 hover:bg-accent/50'
                )}
              >
                {isSelected && (
                  <div className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                    <Check className="h-3 w-3 text-primary-foreground" />
                  </div>
                )}

                <div
                  className="h-16 rounded-md border p-2"
                  style={{
                    backgroundColor: option.preview.background,
                    borderColor: option.preview.muted
                  }}
                >
                  <div className="flex h-full gap-2">
                    <div
                      className="h-full w-5 rounded-sm"
                      style={{ backgroundColor: option.preview.card }}
                    />
                    <div className="flex flex-1 flex-col gap-2">
                      <div
                        className="h-2.5 w-20 rounded-full"
                        style={{ backgroundColor: option.preview.text }}
                      />
                      <div
                        className="h-2 w-full rounded-full"
                        style={{ backgroundColor: option.preview.muted }}
                      />
                      <div
                        className="h-2 w-2/3 rounded-full"
                        style={{ backgroundColor: option.preview.muted }}
                      />
                      <div
                        className="mt-auto h-2.5 w-10 rounded-full"
                        style={{ backgroundColor: option.preview.accent }}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-2 pr-6">
                  <Icon className="mt-0.5 h-4 w-4 text-primary" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">{option.label}</p>
                    <p className="text-xs leading-5 text-muted-foreground">{option.description}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
