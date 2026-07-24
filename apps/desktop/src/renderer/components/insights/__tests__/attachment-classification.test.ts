import { describe, expect, it } from 'vitest';
import { partitionInsightsDroppedFiles } from '../attachment-classification';

describe('partitionInsightsDroppedFiles', () => {
  it('routes only image formats supported by the image hook to image processing', () => {
    const files = [
      { name: 'one.png', type: 'image/png' },
      { name: 'two.jpg', type: 'image/jpeg' },
      { name: 'three.gif', type: 'image/gif' },
      { name: 'four.webp', type: 'image/webp' },
      { name: 'vector.svg', type: 'image/svg+xml' },
      { name: 'bitmap.bmp', type: 'image/bmp' },
      { name: 'camera.heic', type: 'image/heic' },
      { name: 'report.pdf', type: 'application/pdf' },
      { name: 'unknown.bin', type: '' },
    ];

    const result = partitionInsightsDroppedFiles(files);

    expect(result.imageFiles.map((file) => file.name)).toEqual([
      'one.png',
      'two.jpg',
      'three.gif',
      'four.webp',
    ]);
    expect(result.documentFiles.map((file) => file.name)).toEqual([
      'vector.svg',
      'bitmap.bmp',
      'camera.heic',
      'report.pdf',
      'unknown.bin',
    ]);
  });
});
