/** Metadata a route contributes to the document head. */
export interface PageMetadata {
  /** Full document title. Rendered verbatim, without an appended site suffix. */
  readonly title: string;
  readonly description: string;
  /** Set for pages that should stay out of search indexes, such as the error page. */
  readonly noIndex?: boolean;
}

export const PAGE_METADATA_KEY = 'metadata';
