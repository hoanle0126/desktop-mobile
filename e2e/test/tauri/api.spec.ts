import { browser, expect } from '@wdio/globals';
import '@wdio/native-types';

describe('Tauri API', () => {
  it('should execute basic commands', async () => {
    // Test basic command execution using the execute API
    const result = await browser.tauri.execute(({ core }) => core.invoke('get_platform_info'));
    expect(result).toHaveProperty('os');
    expect(result).toHaveProperty('arch');
    expect(result).toHaveProperty('hostname');
    expect(result).toHaveProperty('memory');
    expect(result).toHaveProperty('cpu');
  });

  it('should handle command errors gracefully', async () => {
    // Test error handling for invalid commands
    await expect(browser.tauri.execute(({ core }) => core.invoke('invalid_command'))).rejects.toThrow();
  });

  it('should execute commands with parameters', async () => {
    // Test command execution with parameters
    const result = (await browser.tauri.execute(({ core }) => core.invoke('get_platform_info'))) as { os: string };
    expect(result).toHaveProperty('os');
    expect(typeof result.os).toBe('string');
  });

  describe('execute - different script types', () => {
    it('should execute function with Tauri APIs and args (with-args branch)', async () => {
      // This tests the with-args branch: function receives Tauri APIs as first param, user args after
      const result = await browser.tauri.execute(
        (tauri, arg1, arg2) => {
          return { tauriHasCore: typeof tauri?.core?.invoke === 'function', arg1, arg2 };
        },
        'first',
        'second',
      );
      expect(result.tauriHasCore).toBe(true);
      expect(result.arg1).toBe('first');
      expect(result.arg2).toBe('second');
    });

    it('should execute statement-style string (return statement)', async () => {
      // This tests the no-args branch with statement-style script like "return document.title"
      const result = await browser.tauri.execute('return 42');
      expect(result).toBe(42);
    });

    it('should execute expression-style string', async () => {
      // This tests the no-args branch with expression-style script
      const result = await browser.tauri.execute('1 + 2 + 3');
      expect(result).toBe(6);
    });

    it('should execute string with variable declaration', async () => {
      // Statement-style: declare variables and return
      const result = await browser.tauri.execute(`
        const x = 10;
        const y = 20;
        return x + y;
      `);
      expect(result).toBe(30);
    });

    it('should execute function with Tauri APIs (no args)', async () => {
      // Function without args should still receive Tauri APIs
      const result = await browser.tauri.execute((tauri) => {
        return { hasCore: typeof tauri?.core !== 'undefined' };
      });
      expect(result.hasCore).toBe(true);
    });

    it('should execute string that accesses Tauri APIs', async () => {
      // String script that uses window.__TAURI__ directly
      const result = await browser.tauri.execute(`
        return typeof window.__TAURI__?.core;
      `);
      expect(result).toBe('object');
    });

    it('should execute async function with args', async () => {
      const result = await browser.tauri.execute(async (tauri, value) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { received: value, hasTauri: !!tauri?.core };
      }, 'async-test');
      expect(result.received).toBe('async-test');
      expect(result.hasTauri).toBe(true);
    });
  });

  describe('emitEvent', () => {
    it('should emit an event to listeners when target is omitted', async () => {
      await browser.tauri.execute(async ({ core }) => {
        const g = globalThis as unknown as {
          __wdioEmittedEvents?: unknown[];
          __TAURI_INTERNALS__: { transformCallback: (cb: (ev: { payload: unknown }) => void) => number };
        };
        g.__wdioEmittedEvents = [];
        const handler = g.__TAURI_INTERNALS__.transformCallback((ev) => {
          g.__wdioEmittedEvents?.push(ev.payload);
        });
        await core.invoke('plugin:event|listen', {
          event: 'wdio:test-emit',
          target: { kind: 'Any' },
          handler,
        });
      });

      await browser.tauri.emitEvent('wdio:test-emit', { message: 'hello from emitEvent' });

      await browser.waitUntil(
        async () => {
          const events = await browser.tauri.execute(() => {
            return (globalThis as unknown as { __wdioEmittedEvents?: unknown[] }).__wdioEmittedEvents ?? [];
          });
          return events.length === 1;
        },
        { timeout: 5000, timeoutMsg: 'expected wdio:test-emit listener to receive event' },
      );

      const events = await browser.tauri.execute(() => {
        return (globalThis as unknown as { __wdioEmittedEvents?: unknown[] }).__wdioEmittedEvents;
      });
      expect(events).toEqual([{ message: 'hello from emitEvent' }]);
    });

    it('should emit an event to a target window label when target is provided', async () => {
      await browser.tauri.execute(async ({ core }) => {
        const g = globalThis as unknown as {
          __wdioTargetedEvents?: unknown[];
          __TAURI_INTERNALS__: { transformCallback: (cb: (ev: { payload: unknown }) => void) => number };
        };
        g.__wdioTargetedEvents = [];
        const handler = g.__TAURI_INTERNALS__.transformCallback((ev) => {
          g.__wdioTargetedEvents?.push(ev.payload);
        });
        await core.invoke('plugin:event|listen', {
          event: 'wdio:test-emit-to',
          target: { kind: 'Any' },
          handler,
        });
      });

      await browser.tauri.emitEvent('wdio:test-emit-to', { count: 42 }, 'main');

      await browser.waitUntil(
        async () => {
          const events = await browser.tauri.execute(() => {
            return (globalThis as unknown as { __wdioTargetedEvents?: unknown[] }).__wdioTargetedEvents ?? [];
          });
          return events.length === 1;
        },
        { timeout: 5000, timeoutMsg: 'expected wdio:test-emit-to listener on main to receive event' },
      );

      const events = await browser.tauri.execute(() => {
        return (globalThis as unknown as { __wdioTargetedEvents?: unknown[] }).__wdioTargetedEvents;
      });
      expect(events).toEqual([{ count: 42 }]);
    });
  });
});
