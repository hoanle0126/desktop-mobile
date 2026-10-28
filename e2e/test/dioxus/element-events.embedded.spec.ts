import { browser, expect } from '@wdio/globals';

async function fieldEvents() {
  return (await browser.execute('return window.__fieldEvents || []')) as unknown as string[];
}

// A field that logs input, change and blur with its value, next to a button to move focus to.
async function fillChangeScratch(initialValue = '') {
  await browser.execute(
    `var scratch = document.querySelector("#change-scratch") || (function () {
      var div = document.createElement("div");
      div.id = "change-scratch";
      document.body.appendChild(div);
      return div;
    })();
    scratch.innerHTML = '<input id="fresh-field" value="${initialValue}"><button id="fresh-other">other</button>';
    window.__fieldEvents = [];
    for (var type of ["input", "change", "blur"]) {
      document.querySelector("#fresh-field").addEventListener(type, function (ev) {
        window.__fieldEvents.push(ev.type + " " + ev.target.value);
      });
    }`,
  );
}

describe('Dioxus element events (embedded)', () => {
  beforeEach(async () => {
    // Blurring first fires any change a field still owes, before the event logs reset.
    await browser.execute(
      'if (document.activeElement) { document.activeElement.blur(); }' +
        'var scratch = document.querySelector("#change-scratch");' +
        'if (scratch) { scratch.innerHTML = ""; }',
    );
  });

  it('should fire change once focus leaves a field Send Keys edited, before blur', async () => {
    await fillChangeScratch();
    const field = browser.$('#fresh-field');
    await field.addValue('ab');
    await field.addValue('c');
    expect(await fieldEvents()).toEqual(['input ab', 'input abc']);
    await browser.$('#fresh-other').click();
    expect(await fieldEvents()).toEqual(['input ab', 'input abc', 'change abc', 'blur abc']);
  });

  it('should fire change after blur when the page moves focus', async () => {
    await fillChangeScratch();
    await browser.$('#fresh-field').addValue('x');
    await browser.execute('document.querySelector("#fresh-other").focus()');
    expect(await fieldEvents()).toEqual(['input x', 'blur x', 'change x']);
  });

  it('should clear with input, then change, then blur', async () => {
    await fillChangeScratch('old');
    await browser.$('#fresh-field').clearValue();
    expect(await fieldEvents()).toEqual(['input ', 'change ', 'blur ']);
  });

  it('should leave the change for setValue until focus leaves', async () => {
    await fillChangeScratch('1');
    await browser.$('#fresh-field').setValue('2');
    expect(await fieldEvents()).toEqual(['input ', 'change ', 'blur ', 'input 2']);
    await browser.$('#fresh-other').click();
    expect(await fieldEvents()).toEqual(['input ', 'change ', 'blur ', 'input 2', 'change 2', 'blur 2']);
  });
});
