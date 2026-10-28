import { browser, expect } from '@wdio/globals';
import { Key } from 'webdriverio';

async function errorOf(action: Promise<unknown>) {
  return action.then(
    () => undefined,
    (error: Error) => error,
  );
}

async function addToScratch(html: string) {
  await browser.execute(`document.querySelector("#change-scratch").insertAdjacentHTML("beforeend", '${html}')`);
}

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

  it('should fire change before blur when the page moves focus', async () => {
    await fillChangeScratch();
    await browser.$('#fresh-field').addValue('x');
    await browser.execute('document.querySelector("#fresh-other").focus()');
    expect(await fieldEvents()).toEqual(['input x', 'change x', 'blur x']);
  });

  it('should take focus off the field when a click lands on an element that cannot take it', async () => {
    await fillChangeScratch();
    await addToScratch('<div id="fresh-plain">plain</div>');
    await browser.$('#fresh-field').addValue('x');
    await browser.$('#fresh-plain').click();
    expect(await fieldEvents()).toEqual(['input x', 'change x', 'blur x']);
    expect(await browser.execute('return document.activeElement === document.body')).toBe(true);
  });

  it("should fire change when a click on the field's label takes focus from it, as a browser does", async () => {
    await fillChangeScratch();
    await addToScratch('<label id="fresh-label" for="fresh-field">label</label>');
    await browser.$('#fresh-field').addValue('x');
    await browser.$('#fresh-label').click();
    expect(await fieldEvents()).toEqual(['input x', 'change x', 'blur x']);
  });

  it('should leave focus where a click handler moves it', async () => {
    await fillChangeScratch();
    await addToScratch('<input id="fresh-target">');
    await browser.execute(
      'document.querySelector("#fresh-other").addEventListener("click", function () {' +
        'document.querySelector("#fresh-target").focus(); });',
    );
    await browser.$('#fresh-other').click();
    expect(await browser.execute('return document.activeElement.id')).toBe('fresh-target');
  });

  it('should fire the change resulting from setValue when Enter is pressed', async () => {
    await fillChangeScratch('1');
    await browser.$('#fresh-field').setValue('2');
    await browser.keys(Key.Enter);
    expect(await fieldEvents()).toEqual(['input ', 'change ', 'blur ', 'input 2', 'change 2']);
    await browser.$('#fresh-other').click();
    expect(await fieldEvents()).toEqual(['input ', 'change ', 'blur ', 'input 2', 'change 2', 'blur 2']);
  });

  it('should set a date input at once, firing input and change', async () => {
    await fillChangeScratch();
    await addToScratch('<input id="fresh-date" type="date">');
    await browser.execute(
      'window.__dateEvents = []; for (var type of ["input", "change"]) {' +
        'document.querySelector("#fresh-date").addEventListener(type, function (ev) {' +
        'window.__dateEvents.push(ev.type + " " + ev.target.value); }); }',
    );
    await browser.$('#fresh-date').setValue('2026-10-21');
    expect(await browser.execute('return window.__dateEvents')).toEqual(['input 2026-10-21', 'change 2026-10-21']);
  });

  it('should leave a read-only field alone, and refuse a disabled one', async () => {
    await fillChangeScratch();
    await addToScratch('<input id="fresh-readonly" readonly value="r"><input id="fresh-disabled" disabled>');
    await browser.$('#fresh-readonly').addValue('x');
    expect(await browser.$('#fresh-readonly').getValue()).toBe('r');
    expect((await errorOf(browser.$('#fresh-disabled').addValue('x')))?.message).toMatch(/interactable/);
  });

  it('should clear with input, then change, then blur', async () => {
    await fillChangeScratch('old');
    await browser.$('#fresh-field').clearValue();
    expect(await fieldEvents()).toEqual(['input ', 'change ', 'blur ']);
  });

  it('should leave an empty field alone on Clear', async () => {
    await fillChangeScratch();
    await browser.$('#fresh-field').clearValue();
    expect(await fieldEvents()).toEqual([]);
  });

  it('should refuse to clear an element that is not editable', async () => {
    await fillChangeScratch();
    await addToScratch('<input id="fresh-box" type="checkbox"><select id="fresh-select"><option>1</option></select>');
    for (const selector of ['#fresh-box', '#fresh-select']) {
      expect((await errorOf(browser.$(selector).clearValue()))?.message).toMatch(/cannot be cleared/);
    }
  });

  it('should leave the change for setValue until focus leaves', async () => {
    await fillChangeScratch('1');
    await browser.$('#fresh-field').setValue('2');
    expect(await fieldEvents()).toEqual(['input ', 'change ', 'blur ', 'input 2']);
    await browser.$('#fresh-other').click();
    expect(await fieldEvents()).toEqual(['input ', 'change ', 'blur ', 'input 2', 'change 2', 'blur 2']);
  });
});
