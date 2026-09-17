import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { getHardeningScript } from 'fath57-activity-log/migrations';

/**
 * The two operational obligations the package cannot fulfil on its own.
 *
 * Both are easy to forget, and neither announces itself: without the cron every
 * audit row quietly lands in the DEFAULT partition, and without the hardening
 * script the application role still owns the audit table it is supposed to be
 * unable to rewrite.
 */
@Injectable()
export class AuditMaintenanceService implements OnApplicationBootstrap {
  private readonly log = new Logger(AuditMaintenanceService.name);

  constructor(private readonly em: EntityManager) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensurePartitions();
    await this.warnIfNotHardened();
  }

  /** Keeps four months of partitions ahead of the current one. */
  @Cron('0 3 1 * *')
  async ensurePartitions(): Promise<void> {
    const now = new Date();
    for (let i = 0; i <= 3; i++) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      await this.em.execute('SELECT audit.create_monthly_partition(?)', [month]);
    }

    // The DEFAULT partition is a tripwire, not a destination. Rows landing there
    // mean the cron has not kept up, and absorbing them later needs a
    // maintenance window.
    const [{ n }] = await this.em.execute<Array<{ n: string }>>(
      'SELECT count(*) AS n FROM audit.logged_actions_default',
    );
    if (Number(n) > 0) {
      this.log.error(
        `${n} audit row(s) are in the DEFAULT partition. Partition creation has ` +
          `fallen behind; see the absorption runbook in SPECIFICATION.md §5.5.`,
      );
    }
  }

  private async warnIfNotHardened(): Promise<void> {
    const [{ owner }] = await this.em.execute<Array<{ owner: string }>>(
      `SELECT pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname = 'logged_actions'`,
    );

    if (owner === 'audit_admin') {
      return;
    }

    this.log.warn(
      `audit.logged_actions is owned by "${owner}", not audit_admin: the audit ` +
        `trail is NOT yet tamper-resistant against the application role. Ask a DBA ` +
        `to run the script below once, as a superuser.`,
    );
    this.log.warn('\n' + getHardeningScript(owner, 'audit_admin'));
  }
}
