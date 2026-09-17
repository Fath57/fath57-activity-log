import { describe, it, expect } from 'vitest';
import { LogOptions } from '../../src/feed/options/log-options';

describe('LogOptions', () => {
  it('should create default options with all default fields explicit', () => {
    const options = LogOptions.defaults();
    const partial = options.toPartial();

    expect(partial.logName).toBe('default');
    expect(partial.events).toEqual(['created', 'updated', 'deleted']);
    expect(partial.logOnlyDirty).toBe(true);
    expect(partial.dontSubmitEmptyLogs).toBe(true);
    expect(partial.softDeleteField).toBe('deletedAt');
  });

  it('should create empty partial options with only explicitly set fields', () => {
    const options = LogOptions.partial().useLogName('invoices').logOnly(['status', 'total']);
    const partial = options.toPartial();

    expect(partial.logName).toBe('invoices');
    expect(partial.logOnly).toEqual(['status', 'total']);
    expect(partial.events).toBeUndefined();
    expect(partial.logOnlyDirty).toBeUndefined();
    expect(partial.dontSubmitEmptyLogs).toBeUndefined();
    expect(partial.logExcept).toBeUndefined();
  });

  it('should support chaining of all options', () => {
    const formatter = (event: string) => `Invoice ${event}`;
    const options = LogOptions.partial()
      .useLogName('billing')
      .logEvents(['created', 'updated'])
      .logExcept(['secretToken'])
      .logOnlyDirty(false)
      .dontSubmitEmptyLogs(false)
      .useSoftDeleteField(false)
      .setDescriptionForEvent(formatter);

    const partial = options.toPartial();

    expect(partial.logName).toBe('billing');
    expect(partial.events).toEqual(['created', 'updated']);
    expect(partial.logExcept).toEqual(['secretToken']);
    expect(partial.logOnlyDirty).toBe(false);
    expect(partial.dontSubmitEmptyLogs).toBe(false);
    expect(partial.softDeleteField).toBe(false);
    expect(partial.description).toBe(formatter);
  });

  it('should reset logOnly when logAll is called', () => {
    const options = LogOptions.partial().logOnly(['status']).logAll();
    const partial = options.toPartial();

    expect(partial.logOnly).toBeUndefined();
    expect(partial.logExcept).toBeUndefined();
  });
});
