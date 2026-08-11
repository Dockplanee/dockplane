import { Provider, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { routes } from '../app/app.routes';
import { Permission } from '../app/core/permissions';
import { Session } from '../app/core/session';
import { DockplaneApi } from '../app/data/dockplane-api';
import { TestApi, TestData } from './test-api';

export interface RenderOptions {
  /** Route parameters a detail view reads from its activated route. */
  readonly params?: Record<string, string>;
  readonly providers?: readonly Provider[];
  /** What the control server answers with. */
  readonly data?: TestData;
  /** Permissions the session holds. Empty by default, so views fail closed. */
  readonly permissions?: readonly Permission[];
}

/** Renders a view against the development fixture and the real route table. */
export async function renderView<T>(
  component: Type<T>,
  options: RenderOptions = {},
): Promise<ComponentFixture<T>> {
  const params = options.params ?? {};

  await TestBed.configureTestingModule({
    imports: [component as Type<unknown>],
    providers: [
      provideRouter(routes),
      { provide: DockplaneApi, useValue: new TestApi(options.data) },
      {
        provide: ActivatedRoute,
        useValue: {
          paramMap: of({
            get: (key: string) => params[key] ?? null,
            has: (key: string) => key in params,
          }),
          snapshot: { paramMap: { get: (key: string) => params[key] ?? null } },
        },
      },
      ...(options.providers ?? []),
    ],
  }).compileComponents();

  signIn(options.permissions ?? []);

  const fixture = TestBed.createComponent(component);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  return fixture;
}

/** Puts a signed-in operator with the given permissions into the session. */
export function signIn(permissions: readonly Permission[]): void {
  TestBed.inject(Session).authenticate({
    kind: 'authenticated',
    user: {
      id: 'user-1',
      email: 'ops@example.internal',
      displayName: 'Ops',
      mfaEnabled: false,
      recoveryCodesRemaining: 0,
    },
    roles: ['Administrator'],
    permissions,
    session: { id: 'session-1', expiresAt: '2026-12-31T00:00:00.000Z' },
  });
}

export function element(fixture: ComponentFixture<unknown>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

export function textOf(fixture: ComponentFixture<unknown>): string {
  return element(fixture).textContent ?? '';
}

/** Heading levels in document order, used to detect skipped levels. */
export function headingLevels(fixture: ComponentFixture<unknown>): number[] {
  return Array.from(element(fixture).querySelectorAll('h1, h2, h3, h4, h5, h6')).map((heading) =>
    Number(heading.tagName.slice(1)),
  );
}
