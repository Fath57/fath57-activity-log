import { describe, expect, it } from 'vitest';
import { ActivityPipeline } from '../../src/core/services/activity-pipeline';
import { registerActivity } from '../../src/core/metadata/register-activity';
import { EntityChange } from '../../src/core/model/entity-change';

class KeyedTicket {
  id?: number;
  title = 'Printer on fire';
}
registerActivity(KeyedTicket, {
  description: (event, ticket: KeyedTicket) => `Ticket #${ticket.id} ${event}`,
});

class PlainTicket {
  id?: number;
}
registerActivity(PlainTicket, { logName: 'plain' });

function creationOf(entity: object): EntityChange {
  return {
    entity,
    entityName: entity.constructor.name,
    operation: 'create',
    identifier: undefined,
    after: {},
  };
}

/**
 * §4.5 — a description formatted before the database assigned the key.
 *
 * `build` runs at onFlush, when a SERIAL or gen_random_uuid() key does not exist
 * yet, so a callback reading it rendered `undefined` on a row whose `subjectId`
 * the adapter went on to resolve correctly. `redescribe` is what lets the
 * subscriber revisit that text once the INSERT has happened.
 */
describe('ActivityPipeline.redescribe', () => {
  const pipeline = new ActivityPipeline();

  it('reformats from the entity as it stands now', () => {
    const ticket = new KeyedTicket();
    const change = creationOf(ticket);

    // Before the INSERT: exactly what `build` would have stored.
    expect(pipeline.redescribe(change, 'created')).toBe('Ticket #undefined created');

    ticket.id = 42;
    expect(pipeline.redescribe(change, 'created')).toBe('Ticket #42 created');
  });

  it('returns undefined when the entity has no description callback', () => {
    // The default `${entityName} ${event}` cannot depend on the key, so the
    // subscriber must not issue a write for it.
    expect(pipeline.redescribe(creationOf(new PlainTicket()), 'created')).toBeUndefined();
  });

  it('returns undefined for an entity that is not tracked at all', () => {
    class Untracked {}
    expect(pipeline.redescribe(creationOf(new Untracked()), 'created')).toBeUndefined();
  });

  it('formats with the event it is given', () => {
    const ticket = new KeyedTicket();
    ticket.id = 7;
    expect(pipeline.redescribe(creationOf(ticket), 'deleted')).toBe('Ticket #7 deleted');
  });
});
