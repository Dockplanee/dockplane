import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError, loadConfig, resolveSecretFiles } from '../src/config/configuration';

/*
Configuration that arrives as a file rather than as a variable.

Anything in a container's environment is readable by whoever can run
`docker inspect` and is inherited by every process the container starts. A
deployment therefore hands secrets over as mounted files, and this is the part
that reads them.
*/
describe('secrets supplied as files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dockplane-config-'));

  const write = (name: string, contents: string): string => {
    const path = join(directory, name);
    writeFileSync(path, contents);

    return path;
  };

  it('reads the value from the file the variable names', () => {
    const path = write('database-url', 'postgres://user:secret@db:5432/dockplane');

    const resolved = resolveSecretFiles({ DATABASE_URL_FILE: path });

    expect(resolved.DATABASE_URL).toBe('postgres://user:secret@db:5432/dockplane');
  });

  /*
   * A file written by an editor or by a shell almost always ends in a newline,
   * and a key with a newline in it is not the key. Trimming here is the
   * difference between a deployment that starts and one that reports an
   * invalid encryption key.
   */
  it('trims what the file ends with', () => {
    const path = write('key', '  a-value-with-surrounding-space \n');

    expect(resolveSecretFiles({ APPLICATION_ENCRYPTION_KEY_FILE: path })).toMatchObject({
      APPLICATION_ENCRYPTION_KEY: 'a-value-with-surrounding-space',
    });
  });

  /*
   * Both forms set at once is a deployment that does not know which value it
   * is running with. Picking one silently would make that permanent.
   */
  it('refuses a setting given as both a value and a file', () => {
    const path = write('both', 'from-the-file');

    expect(() =>
      resolveSecretFiles({
        APPLICATION_ENCRYPTION_KEY: 'from-the-variable',
        APPLICATION_ENCRYPTION_KEY_FILE: path,
      }),
    ).toThrow(ConfigurationError);
  });

  it('names the file it could not read rather than starting without it', () => {
    expect(() => resolveSecretFiles({ DATABASE_URL_FILE: join(directory, 'absent') })).toThrow(
      /absent could not be read/,
    );
  });

  it('leaves ordinary settings alone', () => {
    expect(resolveSecretFiles({ LOG_LEVEL: 'debug' })).toEqual({ LOG_LEVEL: 'debug' });
  });

  it('is applied before the schema is validated', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL_FILE: write('url', 'postgres://dockplane@db:5432/dockplane'),
      APPLICATION_ENCRYPTION_KEY_FILE: write('encryption', Buffer.alloc(32, 7).toString('base64')),
      PUBLIC_APP_URL: 'https://dockplane.example.com',
      AGENT_GATEWAY_ADVERTISED_URL: 'https://dockplane.example.com:9443',
      AGENT_GATEWAY_TLS_CERT_PATH: '/pki/gateway.crt',
      AGENT_GATEWAY_TLS_KEY_PATH: '/pki/gateway.key',
      AGENT_CLIENT_CA_CERT_PATH: '/pki/agent-ca.crt',
      AGENT_CA_CERT_PATH: '/pki/agent-ca.crt',
      AGENT_CA_KEY_PATH: '/pki/agent-ca.key',
    });

    expect(config.DATABASE_URL).toBe('postgres://dockplane@db:5432/dockplane');
    expect(Buffer.from(config.APPLICATION_ENCRYPTION_KEY, 'base64')).toHaveLength(32);
  });
});
