import type { TauriServiceGlobalOptions, TauriServiceOptions } from './types.js';

// One merge rule for the launcher, worker and standalone session: capability options win unless undefined.
export function mergeServiceOptions(
  globalOptions: TauriServiceGlobalOptions = {},
  capabilityOptions?: TauriServiceOptions,
): TauriServiceOptions {
  const definedCapabilityOptions = Object.fromEntries(
    Object.entries(capabilityOptions ?? {}).filter(([, value]) => value !== undefined),
  ) as TauriServiceOptions;
  const merged: TauriServiceOptions = { ...globalOptions, ...definedCapabilityOptions };
  return {
    ...merged,
    captureBackendLogs: merged.captureBackendLogs ?? false,
    captureFrontendLogs: merged.captureFrontendLogs ?? false,
    backendLogLevel: merged.backendLogLevel ?? 'info',
    frontendLogLevel: merged.frontendLogLevel ?? 'info',
  };
}

const DRIVER_START_TIMEOUT = 30_000;
const EMBEDDED_START_TIMEOUT = 60_000;

// Takes merged options. An unset driverProvider means embedded.
export function resolveStartTimeout(options: TauriServiceOptions): number {
  const embedded = (options.driverProvider ?? 'embedded') === 'embedded';
  return options.startTimeout || (embedded ? EMBEDDED_START_TIMEOUT : DRIVER_START_TIMEOUT);
}
