import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { ContainerManagement } from '../../domain/inventory';
import { ManagementBadge } from './management-badge';

/**
 * What the interface says about who owns a container.
 *
 * The label is what an operator reads before deciding anything, so the ordering
 * matters more than the wording: a container nobody can identify, or one whose
 * last change has not been settled, cannot be operated at all — and that
 * outranks where its configuration normally comes from.
 */
function render(management: Partial<ContainerManagement>): HTMLElement {
  const fixture = TestBed.createComponent(ManagementBadge);

  fixture.componentRef.setInput('management', {
    kind: 'managed',
    reconciling: false,
    identityConflict: false,
    ...management,
  });

  fixture.detectChanges();

  return fixture.nativeElement as HTMLElement;
}

describe('the management badge', () => {
  it('names each kind of ownership', () => {
    expect(render({ kind: 'managed' }).textContent).toContain('Managed');
    expect(render({ kind: 'external' }).textContent).toContain('External');
    expect(render({ kind: 'stack' }).textContent).toContain('Stack');
  });

  it('reports an unsettled change instead of the ownership', () => {
    // What the operator needs to know first: nothing may be done to it yet.
    expect(render({ kind: 'managed', reconciling: true }).textContent).toContain('Reconciling');
  });

  it('reports a conflict ahead of everything else', () => {
    const element = render({ kind: 'managed', reconciling: true, identityConflict: true });

    expect(element.textContent).toContain('Conflict');
    expect(element.textContent).not.toContain('Reconciling');
  });

  /*
   * The badge carries a shape as well as a colour, inherited from the status
   * badge it is built on. An operator reading in greyscale still sees a
   * difference between a managed container and one in conflict.
   */
  it('does not rely on colour alone', () => {
    const element = render({ kind: 'managed', identityConflict: true });

    expect(element.querySelector('.glyph')).not.toBeNull();
    expect(element.querySelector('.label')?.textContent).toBe('Conflict');
  });
});
