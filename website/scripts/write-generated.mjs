/*
 * Writes a generated file the way the repository formats everything else.
 *
 * A generator that emits its own idea of formatting produces a file that
 * `prettier --check` rejects for as long as the file exists. Reformatting it by
 * hand does not help: the next generation puts it back. So the generators run
 * the formatter themselves, and the checked-in output is what the check
 * expects.
 *
 * This does not make generation any less reproducible. Prettier is a function
 * of its input and its options, both of which come from the repository.
 */

import { writeFile } from 'node:fs/promises';

import { format, resolveConfig } from 'prettier';

/**
 * @param {string} target Absolute path of the file to write.
 * @param {string} contents Generated source, before formatting.
 */
export async function writeGenerated(target, contents) {
  const options = (await resolveConfig(target)) ?? {};
  const formatted = await format(contents, { ...options, filepath: target });

  await writeFile(target, formatted, 'utf8');
}
