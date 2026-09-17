import { describe, it, expect, beforeEach } from 'vitest';
import { ActivityMetadataStorage } from '../../src/feed/metadata/activity-metadata-storage';
import { LogsActivity } from '../../src/feed/decorators/logs-activity.decorator';

describe('ActivityMetadataStorage', () => {
  beforeEach(() => {
    ActivityMetadataStorage.clear();
  });

  it('should store and retrieve configuration for a decorated class', () => {
    @LogsActivity({ logName: 'users', logOnly: ['email'] })
    class UserEntity {}

    const config = ActivityMetadataStorage.get(UserEntity);
    expect(config).toBeDefined();
    expect(config?.logName).toBe('users');
    expect(config?.logOnly).toEqual(['email']);
  });

  it('should resolve metadata along the prototype chain for subclasses (inheritance/STI)', () => {
    @LogsActivity({ logName: 'base_documents', logOnly: ['title'] })
    class BaseDocument {}

    class InvoiceDocument extends BaseDocument {}
    class ReceiptDocument extends InvoiceDocument {}

    // Subclasses should resolve base metadata
    expect(ActivityMetadataStorage.has(InvoiceDocument)).toBe(true);
    expect(ActivityMetadataStorage.get(InvoiceDocument)?.logName).toBe('base_documents');
    expect(ActivityMetadataStorage.get(ReceiptDocument)?.logOnly).toEqual(['title']);
  });

  it('should allow subclass to override parent metadata', () => {
    @LogsActivity({ logName: 'base_items' })
    class BaseItem {}

    @LogsActivity({ logName: 'special_items' })
    class SpecialItem extends BaseItem {}

    expect(ActivityMetadataStorage.get(BaseItem)?.logName).toBe('base_items');
    expect(ActivityMetadataStorage.get(SpecialItem)?.logName).toBe('special_items');
  });

  it('should return undefined for undecorated classes', () => {
    class RegularClass {}

    expect(ActivityMetadataStorage.has(RegularClass)).toBe(false);
    expect(ActivityMetadataStorage.get(RegularClass)).toBeUndefined();
  });
});
