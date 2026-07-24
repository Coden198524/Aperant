/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  blobToBase64: vi.fn(),
  createThumbnail: vi.fn(),
}));

vi.mock('../../ImageUpload', () => ({
  blobToBase64: mocks.blobToBase64,
  createThumbnail: mocks.createThumbnail,
  generateImageId: () => 'generated-image-id',
  isValidImageMimeType: (mimeType: string) => [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ].includes(mimeType),
  resolveFilename: (filename: string) => filename,
}));

import { useImageUpload } from '../useImageUpload';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('useImageUpload scope invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.blobToBase64.mockResolvedValue('data:image/png;base64,AAAA');
  });

  it('does not write an image whose thumbnail resolves after the owning scope changes', async () => {
    const thumbnail = deferred<string>();
    mocks.createThumbnail.mockReturnValue(thumbnail.promise);
    const onImagesChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ scopeKey }) => useImageUpload({
        images: [],
        onImagesChange,
        scopeKey,
      }),
      { initialProps: { scopeKey: 'project-a/session-a' } },
    );
    const file = new File(['image'], 'old-session.png', { type: 'image/png' });
    let processing!: Promise<void>;

    act(() => {
      processing = result.current.processFiles([file]);
    });
    await waitFor(() => expect(mocks.createThumbnail).toHaveBeenCalledTimes(1));

    rerender({ scopeKey: 'project-a/session-b' });
    await act(async () => {
      thumbnail.resolve('data:image/png;base64,THUMB');
      await processing;
    });

    expect(onImagesChange).not.toHaveBeenCalled();
  });

  it('still writes a completed image while the owning scope remains current', async () => {
    mocks.createThumbnail.mockResolvedValue('data:image/png;base64,THUMB');
    const onImagesChange = vi.fn();
    const { result } = renderHook(() => useImageUpload({
      images: [],
      onImagesChange,
      scopeKey: 'project-a/session-a',
    }));
    const file = new File(['image'], 'current-session.png', { type: 'image/png' });

    await act(async () => {
      await result.current.processFiles([file]);
    });

    expect(onImagesChange).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'generated-image-id',
        filename: 'current-session.png',
        mimeType: 'image/png',
      }),
    ]);
  });
});
