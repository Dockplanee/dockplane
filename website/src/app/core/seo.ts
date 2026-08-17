import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';

import { PageMetadata, StructuredData } from './page-metadata';
import { SITE_NAME, absoluteUrl } from './site.config';

/** Social card rendered from the brand mark. Kept in sync with public/social-card.png. */
const SOCIAL_CARD_PATH = '/social-card.png';
const SOCIAL_CARD_WIDTH = '1200';
const SOCIAL_CARD_HEIGHT = '630';

@Injectable({ providedIn: 'root' })
export class Seo {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);

  apply(metadata: PageMetadata, path: string): void {
    const canonical = absoluteUrl(path);
    const socialCard = absoluteUrl(SOCIAL_CARD_PATH);

    this.title.setTitle(metadata.title);

    this.meta.updateTag({ name: 'description', content: metadata.description });
    this.meta.updateTag({
      name: 'robots',
      content: metadata.noIndex ? 'noindex, follow' : 'index, follow',
    });

    this.meta.updateTag({ property: 'og:type', content: 'website' });
    this.meta.updateTag({ property: 'og:site_name', content: SITE_NAME });
    this.meta.updateTag({ property: 'og:locale', content: 'en' });
    this.meta.updateTag({ property: 'og:title', content: metadata.title });
    this.meta.updateTag({ property: 'og:description', content: metadata.description });
    this.meta.updateTag({ property: 'og:url', content: canonical });
    this.meta.updateTag({ property: 'og:image', content: socialCard });
    this.meta.updateTag({ property: 'og:image:width', content: SOCIAL_CARD_WIDTH });
    this.meta.updateTag({ property: 'og:image:height', content: SOCIAL_CARD_HEIGHT });
    this.meta.updateTag({
      property: 'og:image:alt',
      content: `${SITE_NAME} — self-hosted multi-host Docker management`,
    });

    this.meta.updateTag({ name: 'twitter:card', content: 'summary_large_image' });
    this.meta.updateTag({ name: 'twitter:title', content: metadata.title });
    this.meta.updateTag({ name: 'twitter:description', content: metadata.description });
    this.meta.updateTag({ name: 'twitter:image', content: socialCard });

    this.setCanonical(canonical);
    this.setStructuredData(metadata.structuredData);
  }

  /**
   * The page's JSON-LD, or none.
   *
   * One element, replaced on every navigation, so a page that says nothing
   * structured does not inherit what the last one said.
   *
   * `<` is escaped rather than written literally. A description holding the
   * characters `</script>` would otherwise close the element early and put the
   * rest of the document's head into the page.
   */
  private setStructuredData(data: StructuredData | undefined): void {
    const head = this.document.head;
    const existing = head.querySelector<HTMLScriptElement>('script[type="application/ld+json"]');

    if (!data) {
      existing?.remove();
      return;
    }

    const script = existing ?? this.document.createElement('script');

    script.setAttribute('type', 'application/ld+json');
    script.textContent = JSON.stringify(data).replace(/</g, '\\u003c');

    if (!existing) {
      head.appendChild(script);
    }
  }

  private setCanonical(href: string): void {
    const head = this.document.head;
    let link = head.querySelector<HTMLLinkElement>('link[rel="canonical"]');

    if (!link) {
      link = this.document.createElement('link');
      link.setAttribute('rel', 'canonical');
      head.appendChild(link);
    }

    link.setAttribute('href', href);
  }
}
