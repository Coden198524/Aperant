/**
 * @vitest-environment jsdom
 */
/**
 * AuthChoiceStep component tests
 *
 * Tests for the authentication choice step in the onboarding wizard.
 * Verifies OAuth button, API Key button, skip button, and ProfileEditDialog integration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AuthChoiceStep } from './AuthChoiceStep';
import type { APIProfile } from '@shared/types/profile';

const translations: Record<string, string> = {
  'authChoice.title': '选择你的验证方式',
  'authChoice.description': '选择你希望如何连接 Claude。你后续也可以在设置中修改。',
  'authChoice.oauthTitle': '使用 Anthropic 账户登录',
  'authChoice.oauthDescription': '使用你的 Anthropic 账户进行验证，流程简单且安全。',
  'authChoice.apiKeyTitle': '使用自定义 API 密钥',
  'authChoice.apiKeyDescription': '使用你自己的 Anthropic 或兼容 API 提供商密钥。这个方式仍属高度实验性功能，可能会产生较高费用。',
  'authChoice.info': '两种方式都能完整使用 Claude Code 功能，按你的使用偏好选择即可。',
  'authChoice.skip': '暂时跳过'
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] || key,
    i18n: { language: 'zh-CN' }
  })
}));

// Mock the settings store
const mockGoToNext = vi.fn();
const mockGoToPrevious = vi.fn();
const mockSkipWizard = vi.fn();
const mockOnAPIKeyPathComplete = vi.fn();

// Dynamic profiles state for testing
let mockProfiles: APIProfile[] = [];

const mockUseSettingsStore = (selector?: any) => {
  const state = {
    profiles: mockProfiles,
    profilesLoading: false,
    profilesError: null,
    setProfiles: vi.fn((newProfiles) => { mockProfiles = newProfiles; }),
    setProfilesLoading: vi.fn(),
    setProfilesError: vi.fn(),
    saveProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    setActiveProfile: vi.fn()
  };
  if (!selector || selector.toString().includes('profiles')) {
    return state;
  }
  return selector(state);
};

vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector) => mockUseSettingsStore(selector))
}));

// Mock ProfileEditDialog
vi.mock('../settings/ProfileEditDialog', () => ({
  ProfileEditDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
    if (!open) return null;
    return (
      <div data-testid="profile-edit-dialog">
        <button type="button" onClick={() => onOpenChange(false)}>Close Dialog</button>
      </div>
    );
  }
}));

describe('AuthChoiceStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset profiles state to ensure clean state for each test
    mockProfiles = [];
  });

  describe('Rendering', () => {
    it('should render the auth choice step with all elements', () => {
      render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      // Check for heading
      expect(screen.getByText(translations['authChoice.title'])).toBeInTheDocument();

      // Check for OAuth option
      expect(screen.getByText(translations['authChoice.oauthTitle'])).toBeInTheDocument();

      // Check for API Key option
      expect(screen.getByText(translations['authChoice.apiKeyTitle'])).toBeInTheDocument();

      // Check for skip button
      expect(screen.getByText(translations['authChoice.skip'])).toBeInTheDocument();
    });

    it('should display two auth option cards with equal visual weight', () => {
      const { container } = render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      // Check for grid layout with two columns
      const grid = container.querySelector('.grid');
      expect(grid).toBeInTheDocument();
      expect(grid?.className).toContain('lg:grid-cols-2');
    });

    it('should show icons for each auth option', () => {
      render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      // Both cards should have icon containers
      const iconContainers = document.querySelectorAll('.bg-primary\\/10');
      expect(iconContainers.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('OAuth Button Handler', () => {
    it('should call onNext when OAuth button is clicked', () => {
      render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      const oauthButton = screen.getByText(translations['authChoice.oauthTitle']).closest('.cursor-pointer');
      fireEvent.click(oauthButton!);

      expect(mockGoToNext).toHaveBeenCalledTimes(1);
    });

    it('should proceed to oauth step when OAuth is selected', () => {
      render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      const oauthButton = screen.getByText(translations['authChoice.oauthTitle']).closest('.cursor-pointer');
      fireEvent.click(oauthButton!);

      expect(mockGoToNext).toHaveBeenCalled();
      expect(mockOnAPIKeyPathComplete).not.toHaveBeenCalled();
    });
  });

  describe('API Key Button Handler', () => {
    it('should open ProfileEditDialog when API Key button is clicked', () => {
      render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      const apiKeyButton = screen.getByText(translations['authChoice.apiKeyTitle']).closest('.cursor-pointer');
      fireEvent.click(apiKeyButton!);

      // ProfileEditDialog should be rendered
      expect(screen.getByTestId('profile-edit-dialog')).toBeInTheDocument();
    });

    it('should accept onAPIKeyPathComplete callback prop', async () => {
      // This test verifies the component accepts the callback prop
      // Full integration testing of profile creation detection requires E2E tests
      // due to the complex state management between dialog and store
      mockProfiles = [];

      render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
          onAPIKeyPathComplete={mockOnAPIKeyPathComplete}
        />
      );

      // Click API Key button to open dialog
      const apiKeyButton = screen.getByText(translations['authChoice.apiKeyTitle']).closest('.cursor-pointer');
      fireEvent.click(apiKeyButton!);

      // Dialog should be open - verifies the API key path works
      expect(screen.getByTestId('profile-edit-dialog')).toBeInTheDocument();

      // Close dialog without creating profile
      const closeButton = screen.getByText('Close Dialog');
      fireEvent.click(closeButton);

      // Callback should NOT be called when no profile was created (profiles still empty)
      expect(mockOnAPIKeyPathComplete).not.toHaveBeenCalled();
    });
  });

  describe('Skip Button Handler', () => {
    it('should call onSkip when skip button is clicked', () => {
      render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      const skipButton = screen.getByText(translations['authChoice.skip']);
      fireEvent.click(skipButton);

      expect(mockSkipWizard).toHaveBeenCalledTimes(1);
    });

    it('should have ghost variant for skip button', () => {
      render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      const skipButton = screen.getByText(translations['authChoice.skip']);
      // Ghost variant buttons have specific styling classes
      expect(skipButton.className).toContain('text-muted-foreground');
      expect(skipButton.className).toContain('hover:text-foreground');
    });
  });

  describe('Visual Consistency', () => {
    it('should follow WelcomeStep visual pattern', () => {
      const { container } = render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      // Check for container with proper classes
      const mainContainer = container.querySelector('.flex.h-full.flex-col');
      expect(mainContainer).toBeInTheDocument();

      // Check for max-w-2xl content wrapper
      const contentWrapper = container.querySelector('.max-w-2xl');
      expect(contentWrapper).toBeInTheDocument();

      // Check for centered text
      const centeredText = container.querySelector('.text-center');
      expect(centeredText).toBeInTheDocument();
    });

    it('should display hero icon with shield', () => {
      const { container } = render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      // Shield icon should be in a circle
      const heroIcon = container.querySelector('.h-16.w-16');
      expect(heroIcon).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have descriptive text for each auth option', () => {
      render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      // OAuth option description
      expect(screen.getByText(translations['authChoice.oauthDescription'])).toBeInTheDocument();

      // API Key option description
      expect(screen.getByText(translations['authChoice.apiKeyDescription'])).toBeInTheDocument();
    });

    it('should have helper text explaining both options', () => {
      render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      expect(screen.getByText(translations['authChoice.info'])).toBeInTheDocument();
    });
  });

  describe('AC Coverage', () => {
    it('AC1: should display first-run screen with two clear options', () => {
      render(
        <AuthChoiceStep
          onNext={mockGoToNext}
          onBack={mockGoToPrevious}
          onSkip={mockSkipWizard}
        />
      );

      // Two main options visible
      expect(screen.getByText(translations['authChoice.oauthTitle'])).toBeInTheDocument();
      expect(screen.getByText(translations['authChoice.apiKeyTitle'])).toBeInTheDocument();

      // Both should be clickable cards
      const cards = document.querySelectorAll('.cursor-pointer');
      expect(cards.length).toBeGreaterThanOrEqual(2);
    });
  });
});
