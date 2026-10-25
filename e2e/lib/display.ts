import { startDisplayDaemonFromConfig } from '@wdio/display-server';
import type { Options } from '@wdio/types';

// WebKitGTK (Tauri, Dioxus) hits GTK pixbuf errors at 24-bit colour, and the Tauri fixture's
// clipboard crate needs X11, so their runs use a 16-bit Xvfb instead of WebdriverIO's default.
export const webkitDisplayServer = {
  displayServer: 'xvfb',
  displayServerWidth: 1280,
  displayServerHeight: 1024,
  displayServerDepth: 16,
} as const;

/** Standalone specs bypass the testrunner, which is what starts the display, so they start their own. */
export function startWebKitDisplay() {
  return startDisplayDaemonFromConfig(webkitDisplayServer as Options.Testrunner);
}
