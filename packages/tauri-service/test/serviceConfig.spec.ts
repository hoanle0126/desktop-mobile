import { describe, expect, it } from 'vitest';
import { mergeServiceOptions, resolveStartTimeout } from '../src/serviceConfig.js';

describe('mergeServiceOptions', () => {
  it('should let capability options override global options', () => {
    const merged = mergeServiceOptions({ mode: 'native', windowLabel: 'main' }, { mode: 'browser' });

    expect(merged).toMatchObject({ mode: 'browser', windowLabel: 'main' });
  });

  it('should keep a global option when the capability sets it to undefined', () => {
    const merged = mergeServiceOptions(
      { mode: 'browser', devServerUrl: 'http://localhost:1420', driverProvider: 'external' },
      { mode: undefined, devServerUrl: undefined, driverProvider: undefined },
    );

    expect(merged).toMatchObject({
      mode: 'browser',
      devServerUrl: 'http://localhost:1420',
      driverProvider: 'external',
    });
  });

  it('should leave driverProvider unset when no options set it', () => {
    expect(mergeServiceOptions({}, undefined).driverProvider).toBeUndefined();
  });

  it('should default the log capture options', () => {
    expect(mergeServiceOptions()).toMatchObject({
      captureBackendLogs: false,
      captureFrontendLogs: false,
      backendLogLevel: 'info',
      frontendLogLevel: 'info',
    });
  });
});

describe('resolveStartTimeout', () => {
  it('should use the embedded default when no provider is set', () => {
    expect(resolveStartTimeout({})).toBe(60000);
  });

  it('should use the embedded default for the embedded provider', () => {
    expect(resolveStartTimeout({ driverProvider: 'embedded' })).toBe(60000);
  });

  it.each(['external', 'crabnebula'] as const)(
    'should use the driver default for the %s provider',
    (driverProvider) => {
      expect(resolveStartTimeout({ driverProvider })).toBe(30000);
    },
  );

  it('should prefer an explicit startTimeout over the provider default', () => {
    expect(resolveStartTimeout({ driverProvider: 'external', startTimeout: 45000 })).toBe(45000);
  });
});
