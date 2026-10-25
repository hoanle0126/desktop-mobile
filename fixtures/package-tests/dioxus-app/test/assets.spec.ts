import { expect } from '@wdio/globals';
import '@wdio/native-types';

describe('Dioxus asset bundling (package smoke)', () => {
  it('should apply the stylesheet dx bundled with asset!()', async () => {
    const marker = await browser.$('#bundled-style');
    await marker.waitForExist();
    const width = await marker.getCSSProperty('width');
    expect(width.parsed.value).toBe(48);
  });
});
