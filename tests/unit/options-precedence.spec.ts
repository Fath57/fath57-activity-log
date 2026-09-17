import { describe, it, expect } from 'vitest';
import { LogOptions } from '../../src/feed/options/log-options';
import { ActivityOptionsConfig, FeedModuleOptions } from '../../src/feed/interfaces/activity-options.interface';

function resolveEffectiveOptions(
  moduleOptions: FeedModuleOptions | undefined,
  decoratorOpts: ActivityOptionsConfig | undefined,
  dynamicOpts: Partial<ActivityOptionsConfig> | undefined,
) {
  const defaultLogName = moduleOptions?.defaultLogName ?? 'default';
  const defaultSoftDeleteField = moduleOptions?.softDeleteField ?? 'deletedAt';

  return {
    logName: dynamicOpts?.logName ?? decoratorOpts?.logName ?? defaultLogName,
    events: dynamicOpts?.events ?? decoratorOpts?.events ?? ['created', 'updated', 'deleted'],
    logOnly: dynamicOpts?.logOnly ?? decoratorOpts?.logOnly,
    logExcept: dynamicOpts?.logExcept ?? decoratorOpts?.logExcept,
    logOnlyDirty: dynamicOpts?.logOnlyDirty ?? decoratorOpts?.logOnlyDirty ?? true,
    dontSubmitEmptyLogs: dynamicOpts?.dontSubmitEmptyLogs ?? decoratorOpts?.dontSubmitEmptyLogs ?? true,
    softDeleteField: dynamicOpts?.softDeleteField ?? decoratorOpts?.softDeleteField ?? defaultSoftDeleteField,
    description: dynamicOpts?.description ?? decoratorOpts?.description,
  };
}

describe('Options Precedence', () => {
  const moduleDefaults: FeedModuleOptions = {
    defaultLogName: 'app-default',
    defaultCauserType: 'User',
    softDeleteField: 'archivedAt',
  };

  const decoratorOptions: ActivityOptionsConfig = {
    logName: 'invoice-decorator',
    logOnly: ['status', 'amount'],
    logOnlyDirty: true,
  };

  it('should let decorator override module defaults', () => {
    const resolved = resolveEffectiveOptions(moduleDefaults, decoratorOptions, undefined);

    expect(resolved.logName).toBe('invoice-decorator');
    expect(resolved.logOnly).toEqual(['status', 'amount']);
    expect(resolved.softDeleteField).toBe('archivedAt'); // From module default
    expect(resolved.events).toEqual(['created', 'updated', 'deleted']); // Framework default
  });

  it('should let dynamic getActivitylogOptions override only explicitly set fields', () => {
    // Dynamic override only changes logName and description
    const dynamicOptions = LogOptions.partial()
      .useLogName('dynamic-invoices')
      .setDescriptionForEvent((event) => `Dynamic ${event}`)
      .toPartial();

    const resolved = resolveEffectiveOptions(moduleDefaults, decoratorOptions, dynamicOptions);

    expect(resolved.logName).toBe('dynamic-invoices'); // Overridden dynamically
    expect(resolved.logOnly).toEqual(['status', 'amount']); // Preserved from decorator
    expect(resolved.softDeleteField).toBe('archivedAt'); // Preserved from module default
    expect(typeof resolved.description).toBe('function');
  });

  it('should not override lower levels when dynamic options does not set a field', () => {
    const dynamicOptions = LogOptions.partial().logOnly(['status']).toPartial();

    const resolved = resolveEffectiveOptions(moduleDefaults, decoratorOptions, dynamicOptions);

    expect(resolved.logOnly).toEqual(['status']); // Overridden
    expect(resolved.logName).toBe('invoice-decorator'); // Preserved from decorator
  });
});
