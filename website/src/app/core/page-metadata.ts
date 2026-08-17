/** Metadata a route contributes to the document head. */
export interface PageMetadata {
  /** Full document title. Rendered verbatim, without an appended site suffix. */
  readonly title: string;
  readonly description: string;
  /** Set for pages that should stay out of search indexes, such as the error page. */
  readonly noIndex?: boolean;
  /**
   * A JSON-LD description of what this page is about.
   *
   * Only where there is something to say that the meta tags do not already say,
   * and only claims the project can stand behind. A version, a release date, a
   * price or a rating would each be a statement about the product, and this is
   * not the place any of them is decided.
   */
  readonly structuredData?: StructuredData;
}

/** A JSON-LD node. Serialised into the document head as written. */
export type StructuredData = Readonly<Record<string, unknown>>;

export const PAGE_METADATA_KEY = 'metadata';
