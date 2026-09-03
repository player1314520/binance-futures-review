export const CLASSIC_REVIEW_EXPORT_FORMAT: 'rv-classic-review-export/1';

export const CLASSIC_REVIEW_EXPORT_LIMITS: Readonly<{
  reviewCount: number;
  sourceFieldCharacters: number;
  totalReviewCharacters: number;
  reviewsStorageBytes: number;
  guardsStorageBytes: number;
  serializedBytes: number;
}>;

export class ClassicReviewExportError extends Error {
  readonly code: string;
}

export type ClassicReviewStorage = Pick<Storage, 'getItem'>;

export function buildClassicReviewExport(storage?: ClassicReviewStorage): Readonly<{
  format: typeof CLASSIC_REVIEW_EXPORT_FORMAT;
  reviews: readonly Readonly<Record<string, unknown>>[];
  riskLimits: Readonly<Record<string, number>> | null;
}>;

export function serializeClassicReviewExport(storage?: ClassicReviewStorage): string;
