import { EntityManager } from '@mikro-orm/core';
import { ActivityAdapter } from '../../core/ports';
import { MikroOrmChangeCapture } from './mikro-orm-change-capture';
import { MikroOrmActivityStore } from './mikro-orm-activity-store';
import { MikroOrmActivityReader } from './mikro-orm-activity-reader';
import { MikroOrmSessionBinder } from './mikro-orm-session-binder';

/**
 * The MikroORM + PostgreSQL profile, assembled.
 *
 * This object is the whole of what a second profile replaces: four ports over a
 * different ORM's lifecycle events. `adapter-conformance.suite.ts` is the
 * acceptance criterion any replacement must pass.
 */
export class MikroOrmActivityAdapter implements ActivityAdapter {
  readonly name = 'mikro-orm';
  readonly capture: MikroOrmChangeCapture;
  readonly store: MikroOrmActivityStore;
  readonly reader: MikroOrmActivityReader;
  readonly binder: MikroOrmSessionBinder;

  constructor(em: EntityManager, sessionVariableName = 'app.current_user_id') {
    this.capture = new MikroOrmChangeCapture();
    this.store = new MikroOrmActivityStore(em);
    this.reader = new MikroOrmActivityReader(em);
    this.binder = new MikroOrmSessionBinder(em, sessionVariableName);
  }
}
