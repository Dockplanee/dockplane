import { describe, expect, it } from 'vitest';

import {
  emptyStackForm,
  environmentChanges,
  formFromConfiguration,
  problemsIn,
  validationEnvironment,
} from './stack-form-model';

/**
 * What a stack form sends, and what it refuses to send.
 *
 * The secret rule is the whole point of these: a stored secret was never shown
 * to this interface, so nothing it sends may claim to know one. Everything here
 * is a pure function, so the rule is checked without rendering anything.
 */
describe('what a stack form sends', () => {
  const stored = () =>
    formFromConfiguration({
      name: 'shop',
      hostId: 'host-1',
      compose: 'services:\n  web:\n    image: nginx\n',
      environment: [
        { key: 'APP_ENV', secret: false, value: 'production' },
        { key: 'DB_PASSWORD', secret: true },
      ],
    });

  it('never gives a stored secret a value', () => {
    const secret = stored().environment.find((row) => row.key === 'DB_PASSWORD')!;

    expect(secret.value).toBe('');
    expect(secret.stored).toBe(true);
  });

  it('leaves a secret nobody touched alone', () => {
    const changes = environmentChanges(stored().environment);

    expect(changes).toContainEqual({ operation: 'unchanged', key: 'DB_PASSWORD' });
  });

  /*
   * The mask is what the interface shows in place of a secret. Sending it back
   * would store the mask as the credential.
   */
  it('sends no masking characters as a value', () => {
    const changes = environmentChanges(stored().environment);

    expect(JSON.stringify(changes)).not.toContain('•');
  });

  it('sends a changed secret as a secret', () => {
    const form = stored();
    const rows = form.environment.map((row) =>
      row.key === 'DB_PASSWORD' ? { ...row, action: 'change' as const, value: 'new-one' } : row,
    );

    expect(environmentChanges(rows)).toContainEqual({
      operation: 'set-secret',
      key: 'DB_PASSWORD',
      value: 'new-one',
    });
  });

  it('sends a removal as a removal', () => {
    const rows = stored().environment.map((row) =>
      row.key === 'DB_PASSWORD' ? { ...row, action: 'remove' as const } : row,
    );

    expect(environmentChanges(rows)).toContainEqual({ operation: 'remove', key: 'DB_PASSWORD' });
  });

  it('sends an ordinary variable as an ordinary variable', () => {
    expect(environmentChanges(stored().environment)).toContainEqual({
      operation: 'set',
      key: 'APP_ENV',
      value: 'production',
    });
  });

  it('drops a variable with no name rather than sending an empty one', () => {
    const rows = [
      ...stored().environment,
      { key: '   ', value: 'x', secret: false, stored: false, action: 'unchanged' as const },
    ];

    expect(environmentChanges(rows)).toHaveLength(2);
  });

  /*
   * The compiler needs the values to resolve the file, including the secrets
   * somebody has just typed. A stored secret has no value to send, and asking
   * for one would mean revealing it first.
   */
  it('sends the values a validation needs and no stored secret', () => {
    const values = validationEnvironment(stored().environment);

    expect(values).toContainEqual({ key: 'APP_ENV', value: 'production', secret: false });
    expect(values).toContainEqual({ key: 'DB_PASSWORD', value: '', secret: true });
  });
});

describe('what a stack form refuses to send', () => {
  it('wants a name and a host when creating', () => {
    const problems = problemsIn(emptyStackForm(), { requireIdentity: true });

    expect(problems.map((problem) => problem.field)).toEqual(['name', 'hostId']);
  });

  it('asks neither of an edit, which changes neither', () => {
    const problems = problemsIn(emptyStackForm(), { requireIdentity: false });

    expect(problems).toHaveLength(0);
  });

  it('refuses a name Compose would not accept', () => {
    const form = { ...emptyStackForm(), name: 'Shop Stack', hostId: 'host-1' };

    expect(problemsIn(form, { requireIdentity: true })[0].field).toBe('name');
  });

  it('refuses an empty Compose file', () => {
    const form = { ...emptyStackForm(), name: 'shop', hostId: 'host-1', compose: '  ' };

    expect(problemsIn(form, { requireIdentity: true })[0].field).toBe('compose');
  });

  it('refuses a new secret with no value', () => {
    const form = {
      ...emptyStackForm(),
      environment: [
        { key: 'TOKEN', value: '', secret: true, stored: false, action: 'unchanged' as const },
      ],
    };

    expect(problemsIn(form, { requireIdentity: false })[0].field).toBe('environment.0.value');
  });

  it('refuses the same variable twice', () => {
    const form = {
      ...emptyStackForm(),
      environment: [
        { key: 'A', value: '1', secret: false, stored: false, action: 'unchanged' as const },
        { key: 'A', value: '2', secret: false, stored: false, action: 'unchanged' as const },
      ],
    };

    expect(problemsIn(form, { requireIdentity: false })[0].message).toContain('twice');
  });
});
