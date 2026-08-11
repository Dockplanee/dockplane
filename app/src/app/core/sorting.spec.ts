import { signal } from '@angular/core';

import { createSort } from './sorting';

interface Row {
  readonly name: string;
  readonly value?: number;
}

describe('createSort', () => {
  const rows = signal<readonly Row[]>([
    { name: 'docker-02', value: 8 },
    { name: 'docker-01', value: 12 },
    { name: 'docker-04' },
    { name: 'docker-03', value: 23 },
  ]);

  const build = () =>
    createSort<Row, 'name' | 'value'>(
      rows,
      { name: (row) => row.name, value: (row) => row.value },
      { key: 'name', direction: 'asc' },
    );

  it('sorts by the initial column', () => {
    expect(
      build()
        .sorted()
        .map((row) => row.name),
    ).toEqual(['docker-01', 'docker-02', 'docker-03', 'docker-04']);
  });

  it('reverses when the active column is toggled again', () => {
    const sort = build();
    sort.toggle('name');

    expect(sort.state().direction).toBe('desc');
    expect(sort.sorted()[0].name).toBe('docker-04');
  });

  it('starts ascending when a different column is chosen', () => {
    const sort = build();
    sort.toggle('name');
    sort.toggle('value');

    expect(sort.state()).toEqual({ key: 'value', direction: 'asc' });
  });

  it('places rows without a value last regardless of direction', () => {
    const sort = build();
    sort.toggle('value');

    expect(sort.sorted().at(-1)?.name).toBe('docker-04');
  });

  it('exposes the aria-sort state for the active column only', () => {
    const sort = build();

    expect(sort.ariaSort('name')).toBe('ascending');
    expect(sort.ariaSort('value')).toBe('none');
  });
});
