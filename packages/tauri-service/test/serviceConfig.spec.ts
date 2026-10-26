import { describe, expect, it } from 'vitest';
import { mergeServiceOptions } from '../src/serviceConfig.js';

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

  it('should default commandTimeout and logLevel when neither side sets them', () => {
    expect(mergeServiceOptions()).toMatchObject({ commandTimeout: 30000, logLevel: 'info' });
  });

  it('should let a global commandTimeout win over the default', () => {
    expect(mergeServiceOptions({ commandTimeout: 5000 }).commandTimeout).toBe(5000);
  });

  it('should let a capability commandTimeout and logLevel win over the global values', () => {
    const merged = mergeServiceOptions(
      { commandTimeout: 5000, logLevel: 'debug' },
      { commandTimeout: 10000, logLevel: 'error' },
    );

    expect(merged).toMatchObject({ commandTimeout: 10000, logLevel: 'error' });
  });

  it('should keep a global logLevel when the capability leaves it unset', () => {
    expect(mergeServiceOptions({ logLevel: 'debug' }, { logLevel: undefined }).logLevel).toBe('debug');
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
