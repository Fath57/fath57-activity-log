import { describe, expect, it, vi } from 'vitest';
import { FeedModule } from '../../src/feed/feed.module';
import { AuditModule } from '../../src/audit/audit.module';
import { FEED_MODULE_OPTIONS } from '../../src/feed/constants/feed.constants';
import { ActivityAdapter } from '../../src/core/ports';
import {
  validateFeedOptions,
  warnOnWeakSessionScope,
} from '../../src/core/services/validate-feed-options';

/**
 * §2.2 and §11.2 — the adapter is part of the public module API, and a
 * configuration the adapter cannot honour is refused at bootstrap.
 */
const fakeAdapter = (over: Partial<{
  name: string;
  providesBeforeState: boolean;
  batchesByFlush: boolean;
  scope: 'transaction' | 'session' | 'none';
}> = {}): ActivityAdapter => ({
  name: over.name ?? 'fake',
  capture: {
    onChanges: () => {},
    providesBeforeState: over.providesBeforeState ?? true,
    batchesByFlush: over.batchesByFlush ?? true,
  },
  store: { persist: async () => {} },
  binder: over.scope
    ? { bind: async () => {}, scope: over.scope }
    : undefined,
});

describe('FeedModule.forRoot adapter wiring', () => {
  const optionsOf = (mod: any) =>
    mod.providers.find((p: any) => p.provide === FEED_MODULE_OPTIONS).useValue;

  it('accepts an adapter and passes it through to the subscriber options', () => {
    const adapter = fakeAdapter();
    const mod = FeedModule.forRoot({ adapter, defaultLogName: 'billing' });

    expect(optionsOf(mod).adapter).toBe(adapter);
    expect(optionsOf(mod).defaultLogName).toBe('billing');
  });

  it('works with no options at all', () => {
    expect(() => FeedModule.forRoot()).not.toThrow();
    expect(optionsOf(FeedModule.forRoot())).toEqual({});
  });

  it('REFUSES logOnlyDirty on an adapter with no cheap before-state', () => {
    // The alternative is silent degradation: the feed keeps producing rows, but
    // either logs every attribute on every update or pays a read per mutation,
    // and nothing says so. §11.2.
    expect(() =>
      FeedModule.forRoot({
        adapter: fakeAdapter({ name: 'prisma-ish', providesBeforeState: false }),
        logOnlyDirty: true,
      }),
    ).toThrow(/providesBeforeState: false/);
  });

  it('allows logOnlyDirty: false on that same adapter', () => {
    expect(() =>
      FeedModule.forRoot({
        adapter: fakeAdapter({ providesBeforeState: false }),
        logOnlyDirty: false,
      }),
    ).not.toThrow();
  });

  it('does not constrain configuration when no adapter is supplied', () => {
    // Nothing to validate against: the default MikroORM profile supports it.
    expect(() => FeedModule.forRoot({ logOnlyDirty: true })).not.toThrow();
  });

  it('warns, without throwing, on a session-scoped binder', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      FeedModule.forRoot({ adapter: fakeAdapter({ name: 'mysql-ish', scope: 'session' }) });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toMatch(/SESSION scope/);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent for a transaction-scoped binder', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      FeedModule.forRoot({ adapter: fakeAdapter({ scope: 'transaction' }) });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('validateFeedOptions', () => {
  it('is a no-op without an adapter', () => {
    expect(() => validateFeedOptions({ logOnlyDirty: true })).not.toThrow();
  });

  it('names the offending adapter in the message', () => {
    expect(() =>
      validateFeedOptions(
        { logOnlyDirty: true },
        fakeAdapter({ name: 'drizzle-ish', providesBeforeState: false }),
      ),
    ).toThrow(/"drizzle-ish"/);
  });

  it('warnOnWeakSessionScope tolerates a missing binder', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnOnWeakSessionScope(fakeAdapter());
      warnOnWeakSessionScope(undefined);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('AuditModule.forRoot adapter wiring', () => {
  it('accepts an adapter alongside the engine options', () => {
    const adapter = fakeAdapter({ scope: 'transaction' });
    const mod: any = AuditModule.forRoot({
      adapter,
      sessionVariableName: 'app.uid',
      sessionBinding: 'lazy',
    });

    const opts = mod.providers.find((p: any) => typeof p === 'object' && 'useValue' in p).useValue;
    expect(opts.adapter).toBe(adapter);
    expect(opts.sessionVariableName).toBe('app.uid');
    expect(opts.sessionBinding).toBe('lazy');
  });
});
