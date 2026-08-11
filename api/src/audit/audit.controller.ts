import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { AuditService } from './audit.service';

const MAX_PAGE_SIZE = 100;

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  /** Keyset cursor: return entries older than this timestamp. */
  before: z.iso.datetime().optional(),
  action: z.string().max(64).optional(),
});

@Controller('api/v1/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  async list(@Query(new ZodValidationPipe(auditQuery)) query: z.infer<typeof auditQuery>) {
    const entries = await this.audit.list({
      limit: query.limit,
      before: query.before ? new Date(query.before) : undefined,
      action: query.action,
    });

    return {
      entries,
      // Cursor for the next page; absent when the last page was returned.
      nextBefore: entries.length === query.limit ? entries[entries.length - 1].occurredAt : null,
    };
  }
}
