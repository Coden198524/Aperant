// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  OpenSpecPreflightResult,
  OpenSpecTaskConfig,
} from '../../../shared/types';
import { TaskFormFields } from './TaskFormFields';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: 'en',
    },
  }),
}));

vi.mock('../AgentProfileSelector', () => ({
  AgentProfileSelector: () => <div data-testid="agent-profile-selector" />,
}));

vi.mock('./ClassificationFields', () => ({
  ClassificationFields: () => <div data-testid="classification-fields" />,
}));

vi.mock('../ScreenshotCapture', () => ({
  ScreenshotCapture: () => null,
}));

vi.mock('./ImagePreviewModal', () => ({
  ImagePreviewModal: () => null,
}));

type SelectCallback = (value: string) => void;
let selectCallbacks = new Map<string, SelectCallback>();
let currentSelectCallback: SelectCallback | null = null;

vi.mock('../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: SelectCallback;
    children: ReactNode;
  }) => {
    currentSelectCallback = onValueChange;
    return <div data-value={value}>{children}</div>;
  },
  SelectTrigger: ({
    id,
    children,
  }: {
    id?: string;
    children: ReactNode;
  }) => {
    if (id && currentSelectCallback) {
      selectCallbacks.set(id, currentSelectCallback);
      currentSelectCallback = null;
    }
    return <button type="button" data-testid={`select-trigger-${id}`}>{children}</button>;
  },
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: ReactNode;
  }) => (
    <div role="option" tabIndex={0} data-testid={`select-item-${value}`}>
      {children}
    </div>
  ),
}));

const openSpecConfig: OpenSpecTaskConfig = {
  formatVersion: 1,
  rootKind: 'store',
  storeId: 'shared-specs',
  schemaName: 'product-flow',
  startAction: 'new',
  changeName: 'add-audit-log',
};

const preflight: OpenSpecPreflightResult = {
  valid: true,
  openSpecVersion: '1.6.0',
  rootKind: 'store',
  rootLabel: 'shared-specs',
  initialized: true,
  schemaName: 'product-flow',
  availableSchemas: ['spec-driven', 'spec-driven-with-adr', 'product-flow'],
  registeredStores: ['shared-specs', 'platform-specs'],
  changeExists: false,
  checks: [
    {
      code: 'version',
      ok: true,
      severity: 'info',
      message: 'Pinned OpenSpec 1.6.0 is available.',
    },
    {
      code: 'change',
      ok: false,
      severity: 'warning',
      message: 'Change will be created.',
    },
  ],
};

function renderFields(
  overrides: Partial<React.ComponentProps<typeof TaskFormFields>> = {},
) {
  const onOpenSpecConfigChange = vi.fn();
  const props: React.ComponentProps<typeof TaskFormFields> = {
    description: '',
    onDescriptionChange: vi.fn(),
    title: '',
    onTitleChange: vi.fn(),
    profileId: 'auto',
    model: '',
    thinkingLevel: '',
    onProfileChange: vi.fn(),
    onModelChange: vi.fn(),
    onThinkingLevelChange: vi.fn(),
    onPhaseModelsChange: vi.fn(),
    onPhaseThinkingChange: vi.fn(),
    category: '',
    priority: '',
    complexity: '',
    impact: '',
    onCategoryChange: vi.fn(),
    onPriorityChange: vi.fn(),
    onComplexityChange: vi.fn(),
    onImpactChange: vi.fn(),
    showClassification: false,
    onShowClassificationChange: vi.fn(),
    images: [],
    onImagesChange: vi.fn(),
    requireReviewBeforeCoding: false,
    onRequireReviewChange: vi.fn(),
    developmentMode: 'spec',
    onDevelopmentModeChange: vi.fn(),
    openSpecConfig,
    onOpenSpecConfigChange,
    openSpecPreflight: preflight,
    idPrefix: 'create',
    ...overrides,
  };

  return {
    ...render(<TaskFormFields {...props} />),
    onOpenSpecConfigChange,
  };
}

describe('TaskFormFields OpenSpec controls', () => {
  beforeEach(() => {
    selectCallbacks = new Map();
    currentSelectCallback = null;
  });

  it('renders Schemas and Stores discovered by the live preflight', () => {
    renderFields();

    expect(screen.getByText('tasks:form.openSpec.title')).toBeTruthy();
    expect(screen.getByTestId('select-item-spec-driven')).toBeTruthy();
    expect(screen.getByTestId('select-item-spec-driven-with-adr').textContent).toContain(
      'tasks:form.openSpec.schemaNames.specDrivenWithAdr (spec-driven-with-adr)',
    );
    expect(screen.getByTestId('select-item-product-flow')).toBeTruthy();
    expect(screen.getByTestId('select-item-shared-specs')).toBeTruthy();
    expect(screen.getByTestId('select-item-platform-specs')).toBeTruthy();
    expect(screen.getByText(/Pinned OpenSpec 1\.6\.0 is available\./)).toBeTruthy();
    expect(screen.getByText(/Change will be created\./)).toBeTruthy();
  });

  it('routes dynamic Schema and Store selections into OpenSpec task metadata', () => {
    const { onOpenSpecConfigChange } = renderFields();

    act(() => {
      selectCallbacks.get('create-openspec-schema')?.('spec-driven-with-adr');
      selectCallbacks.get('create-openspec-store')?.('platform-specs');
    });

    expect(onOpenSpecConfigChange).toHaveBeenCalledWith({
      ...openSpecConfig,
      schemaName: 'spec-driven-with-adr',
    });
    expect(onOpenSpecConfigChange).toHaveBeenCalledWith({
      ...openSpecConfig,
      storeId: 'platform-specs',
    });
  });

  it('shows the pinned runtime check while preflight is pending', () => {
    renderFields({
      openSpecPreflight: null,
      openSpecPreflightLoading: true,
    });

    expect(screen.getByText('tasks:form.openSpec.preflightChecking')).toBeTruthy();
  });

  it('does not expose OpenSpec controls in Standard mode', () => {
    renderFields({
      developmentMode: 'standard',
    });

    expect(screen.queryByText('tasks:form.openSpec.title')).toBeNull();
    expect(screen.queryByTestId('select-trigger-create-openspec-schema')).toBeNull();
    expect(screen.queryByTestId('select-trigger-create-openspec-store')).toBeNull();
  });
});
