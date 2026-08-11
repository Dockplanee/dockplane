import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { ZodType } from 'zod';

import { AppError } from './errors';

/**
 * Validates a request payload against a schema.
 *
 * The rejection names only the offending fields. Values are never echoed, so a
 * validation failure cannot reflect a submitted password back to the caller or
 * into a log line.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      const fields = [
        ...new Set(result.error.issues.map((issue) => issue.path.join('.') || 'body')),
      ];

      throw new AppError('VALIDATION_FAILED', `The request was not valid: ${fields.join(', ')}.`);
    }

    return result.data;
  }
}
