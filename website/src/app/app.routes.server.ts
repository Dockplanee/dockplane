import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * Every public page is generated at build time. The output is plain static
 * files, so the marketing site can be hosted independently from the Dockplane
 * control server.
 */
export const serverRoutes: ServerRoute[] = [
  { path: '', renderMode: RenderMode.Prerender },
  { path: 'product', renderMode: RenderMode.Prerender },
  { path: 'features', renderMode: RenderMode.Prerender },
  { path: 'security', renderMode: RenderMode.Prerender },
  { path: 'docs', renderMode: RenderMode.Prerender },
  { path: 'changelog', renderMode: RenderMode.Prerender },
  { path: '404', renderMode: RenderMode.Prerender },
  { path: '**', renderMode: RenderMode.Prerender },
];
