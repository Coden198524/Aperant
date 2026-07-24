import { ALLOWED_IMAGE_TYPES } from '../../../shared/constants';

const SUPPORTED_IMAGE_TYPES = new Set<string>(ALLOWED_IMAGE_TYPES);

export interface InsightsDroppedFilePartition<T> {
  imageFiles: T[];
  documentFiles: T[];
}

/**
 * Keep Insights drag classification aligned with the image upload hook.
 * Every other regular file, including unsupported image formats, remains a
 * local-path document reference.
 */
export function partitionInsightsDroppedFiles<T extends Pick<File, 'type'>>(
  files: readonly T[],
): InsightsDroppedFilePartition<T> {
  const imageFiles: T[] = [];
  const documentFiles: T[] = [];

  for (const file of files) {
    if (SUPPORTED_IMAGE_TYPES.has(file.type)) {
      imageFiles.push(file);
    } else {
      documentFiles.push(file);
    }
  }

  return { imageFiles, documentFiles };
}
