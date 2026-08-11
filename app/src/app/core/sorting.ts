import { Signal, computed, signal } from '@angular/core';

export type SortDirection = 'asc' | 'desc';

export interface SortState<K extends string> {
  readonly key: K;
  readonly direction: SortDirection;
}

/** Value kinds the shared comparator understands. Absent values sort last. */
export type SortValue = string | number | undefined;

function compare(a: SortValue, b: SortValue): number {
  if (a === undefined && b === undefined) {
    return 0;
  }
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }

  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export interface SortController<T, K extends string> {
  readonly state: Signal<SortState<K>>;
  readonly sorted: Signal<readonly T[]>;
  toggle(key: K): void;
  /** `aria-sort` value for a column header. */
  ariaSort(key: K): 'ascending' | 'descending' | 'none';
}

/**
 * Shared sorting behaviour for list views.
 *
 * Features supply a value accessor per column so the comparison stays with the
 * data rather than being reimplemented in every table.
 */
export function createSort<T, K extends string>(
  rows: Signal<readonly T[]>,
  accessors: Record<K, (row: T) => SortValue>,
  initial: SortState<K>,
): SortController<T, K> {
  const state = signal<SortState<K>>(initial);

  const sorted = computed(() => {
    const { key, direction } = state();
    const accessor = accessors[key];
    const factor = direction === 'asc' ? 1 : -1;

    return [...rows()].sort((a, b) => compare(accessor(a), accessor(b)) * factor);
  });

  return {
    state: state.asReadonly(),
    sorted,
    toggle(key: K): void {
      state.update((current) =>
        current.key === key
          ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
          : { key, direction: 'asc' },
      );
    },
    ariaSort(key: K) {
      const current = state();
      if (current.key !== key) {
        return 'none';
      }
      return current.direction === 'asc' ? 'ascending' : 'descending';
    },
  };
}
