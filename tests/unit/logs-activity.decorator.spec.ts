import { beforeEach, describe, expect, it } from 'vitest';
import { LogsActivity } from '../../src/feed/decorators/logs-activity.decorator';
import {
  registerActivity,
  getActivityOptions,
} from '../../src/core/metadata/register-activity';
import { ActivityMetadataStorage } from '../../src/core/metadata/activity-metadata-storage';

describe('@LogsActivity / registerActivity', () => {
  beforeEach(() => ActivityMetadataStorage.clear());

  it('records the options passed to the decorator', () => {
    @LogsActivity({ logName: 'billing', logOnly: ['total'] })
    class Invoice {}

    expect(getActivityOptions(Invoice)).toEqual({ logName: 'billing', logOnly: ['total'] });
  });

  it('records an empty config when called with no arguments', () => {
    @LogsActivity()
    class Bare {}

    expect(getActivityOptions(Bare)).toEqual({});
    expect(ActivityMetadataStorage.has(Bare)).toBe(true);
  });

  it('leaves an undecorated class unregistered', () => {
    class Untracked {}
    expect(getActivityOptions(Untracked)).toBeUndefined();
    expect(ActivityMetadataStorage.has(Untracked)).toBe(false);
  });

  it('is exactly sugar over registerActivity', () => {
    // The decorator must add no behaviour of its own: an adapter for a
    // schema-first ORM registers through the function and must get the same
    // result. If these two ever diverge, the portability seam of §11.2 is gone.
    @LogsActivity({ logName: 'same' })
    class ViaDecorator {}

    class ViaFunction {}
    registerActivity(ViaFunction, { logName: 'same' });

    expect(getActivityOptions(ViaFunction)).toEqual(getActivityOptions(ViaDecorator));
  });

  it('registers by string key, for ORMs with no class to decorate', () => {
    registerActivity('User', { logName: 'accounts' });

    expect(getActivityOptions('User')).toEqual({ logName: 'accounts' });
  });

  it('keeps class and string registrations in separate slots', () => {
    class User {}
    registerActivity(User, { logName: 'from-class' });
    registerActivity('User', { logName: 'from-string' });

    expect(getActivityOptions(User)).toEqual({ logName: 'from-class' });
    expect(getActivityOptions('User')).toEqual({ logName: 'from-string' });
  });

  it('resolves a subclass through the prototype chain', () => {
    @LogsActivity({ logName: 'base' })
    class BaseEntity {}
    class ConcreteEntity extends BaseEntity {}

    // Single Table Inheritance: the subclass inherits the base registration.
    expect(getActivityOptions(ConcreteEntity)).toEqual({ logName: 'base' });
  });

  it('lets a subclass override its base', () => {
    @LogsActivity({ logName: 'base' })
    class BaseEntity {}
    @LogsActivity({ logName: 'derived' })
    class ConcreteEntity extends BaseEntity {}

    expect(getActivityOptions(ConcreteEntity)).toEqual({ logName: 'derived' });
    expect(getActivityOptions(BaseEntity)).toEqual({ logName: 'base' });
  });

  it('does not key on constructor name', () => {
    // Two classes with the same name in different modules must not collide, and
    // minification renaming a class must not lose its registration.
    const makeClass = () => class Invoice {};
    const A = makeClass();
    const B = makeClass();
    registerActivity(A, { logName: 'a' });

    expect(A.name).toBe(B.name);
    expect(getActivityOptions(A)).toEqual({ logName: 'a' });
    expect(getActivityOptions(B)).toBeUndefined();
  });

  it('lets a later registration replace an earlier one', () => {
    class Invoice {}
    registerActivity(Invoice, { logName: 'first' });
    registerActivity(Invoice, { logName: 'second' });

    expect(getActivityOptions(Invoice)).toEqual({ logName: 'second' });
  });
});
