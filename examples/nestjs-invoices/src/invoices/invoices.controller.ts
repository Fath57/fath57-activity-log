import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ActivityQueryService, ActivityLogger } from 'fath57-activity-log';
import { AuditQueryService } from 'fath57-activity-log';
import { Invoice } from './invoice.entity';

@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly em: EntityManager,
    private readonly feed: ActivityQueryService,
    private readonly audit: AuditQueryService,
    private readonly logger: ActivityLogger,
  ) {}

  /**
   * Wrapped in em.transactional() on purpose. An implicit flush would still be
   * audited, but outside a managed transaction no attribution reaches the
   * trigger and `changed_by` would be NULL.
   */
  @Post()
  async create(@Body() body: { reference: string; total?: string }) {
    return this.em.transactional(async (em) => {
      const invoice = new Invoice();
      invoice.reference = body.reference;
      invoice.total = body.total ?? '0.00';
      em.persist(invoice);
      return invoice;
    });
  }

  @Post(':id/validate')
  async validate(@Param('id') id: string) {
    const invoice = await this.em.findOneOrFail(Invoice, { id });

    // A business milestone, not a CRUD change: nothing on the entity moves, so
    // the subscriber has nothing to report. Log it explicitly.
    await this.logger
      .performedOn(invoice)
      .withEvent('validated')
      .inLog('billing')
      .withProperties({ total: invoice.total })
      .log(`Invoice ${invoice.reference} validated`);

    return { ok: true };
  }

  /**
   * Soft delete. The subscriber sees deletedAt move from null to a date and
   * classifies the event as 'deleted' rather than 'updated'.
   */
  @Delete(':id')
  async softDelete(@Param('id') id: string) {
    await this.em.transactional(async (em) => {
      const invoice = await em.findOneOrFail(Invoice, { id });
      invoice.deletedAt = new Date();
    });
    return { ok: true };
  }

  /**
   * THE ASYMMETRY, on purpose.
   *
   * nativeUpdate emits no entity lifecycle event, so the feed records nothing —
   * compare /activity and /audit after calling this. The trigger records every
   * row it touched, which is precisely what the feed cannot give you.
   */
  @Post('bulk-discount')
  async bulkDiscount(@Body() body: { rate: number }) {
    return this.em.transactional(async (em) => {
      const affected = await em.nativeUpdate(
        Invoice,
        { deletedAt: null },
        { total: this.em.getKnex().raw('total * ?', [1 - body.rate]) as any },
      );
      return { affected, note: 'no feed entries; see /audit' };
    });
  }

  /** Cursor-paginated, and scoped to the caller's tenant by default. */
  @Get(':id/activity')
  async activity(@Param('id') id: string) {
    return this.feed.findForSubject('Invoice', id, { limit: 20 });
  }

  @Get(':id/audit')
  async auditTrail(@Param('id') id: string) {
    return this.audit.findForRow('public', 'invoices', id);
  }
}
