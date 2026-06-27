import { beforeEach, describe, expect, it } from 'vitest';
import { COPY_CODE_SCRIPT, PREVIEW_SCRIPT } from './codeBlockUi.js';

type Listener = (event: { target: FakeElement }) => void;

class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  parent: FakeElement | null = null;
  textContent = '';
  value = '';
  style: Record<string, string> = {};
  selected = false;
  private html = '';

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName.toLowerCase();
    for (const [name, value] of Object.entries(attrs)) {
      this.attributes.set(name, value);
    }
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children.length = 0;

    if (!/<button[^>]*class="[^"]*copy-code[^"]*"/i.test(value)) return;

    const figure = new FakeElement('figure', { class: 'code-block' });
    const button = new FakeElement('button', { class: 'copy-code' });
    button.textContent = 'Copy';
    const code = new FakeElement('code');
    code.textContent = value.match(/<code[^>]*>([\s\S]*?)<\/code>/i)?.[1] ?? '';
    figure.appendChild(button);
    figure.appendChild(code);
    this.appendChild(figure);
  }

  appendChild(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchClick(target: FakeElement = this): void {
    for (const listener of this.listeners.get('click') ?? []) {
      listener({ target });
    }
  }

  closest(selector: string): FakeElement | null {
    let current: FakeElement | null = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parent;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  select(): void {
    this.selected = true;
  }

  matches(selector: string): boolean {
    if (selector === 'form') return this.tagName === 'form';
    if (selector === 'code') return this.tagName === 'code';
    if (selector === '.copy-code') return this.hasClass('copy-code');
    if (selector === '.code-block') return this.hasClass('code-block');
    if (selector === 'input[name="actorId"]') {
      return this.tagName === 'input' && this.getAttribute('name') === 'actorId';
    }
    if (selector === 'input[name="workspaceId"]') {
      return this.tagName === 'input' && this.getAttribute('name') === 'workspaceId';
    }
    return false;
  }

  private hasClass(className: string): boolean {
    return (this.getAttribute('class') ?? '').split(/\s+/).includes(className);
  }
}

class FakeDocument {
  readonly body = new FakeElement('body');
  readonly listeners = new Map<string, Listener[]>();
  fetchBodies: string[] = [];
  readonly form = new FakeElement('form');
  readonly textarea = new FakeElement('textarea', { id: 'content' });
  readonly actor = new FakeElement('input', { name: 'actorId' });
  readonly workspace = new FakeElement('input', { name: 'workspaceId' });
  readonly toggle = new FakeElement('button', {
    class: 'preview-toggle',
    'data-preview-for': 'content',
  });
  readonly pane = new FakeElement('div', {
    class: 'composer-preview',
    'data-preview-for': 'content',
  });

  constructor() {
    this.textarea.value = '```ts\nconst x = 1;\n```';
    this.actor.value = 'ada';
    this.workspace.value = 'wsA';
    this.form.appendChild(this.textarea);
    this.form.appendChild(this.actor);
    this.form.appendChild(this.workspace);
    this.form.appendChild(this.toggle);
    this.form.appendChild(this.pane);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchClick(target: FakeElement): void {
    for (const listener of this.listeners.get('click') ?? []) {
      listener({ target });
    }
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === '.preview-toggle[data-preview-for]') return [this.toggle];
    if (selector === '[data-preview-for]') return [this.toggle, this.pane];
    if (selector === '.copy-code') return [];
    return [];
  }

  getElementById(id: string): FakeElement | null {
    return id === 'content' ? this.textarea : null;
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === '.composer-preview[data-preview-for="content"]') return this.pane;
    return null;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  execCommand(command: string): boolean {
    return command === 'copy';
  }

  previewCopyButton(): FakeElement {
    const button = this.pane.querySelector('.copy-code');
    expect(button).not.toBeNull();
    return button as FakeElement;
  }
}

function installGlobals(document: FakeDocument): string[] {
  const copied: string[] = [];
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: (text: string) => Promise.resolve(copied.push(text)) } },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: (_url: string, init: { body: string }) => {
      document.fetchBodies.push(init.body);
      return Promise.resolve({
        text: () =>
          Promise.resolve(
            '<figure class="code-block" data-lang="ts"><button class="copy-code" type="button">Copy</button><pre><code>const x = 1;</code></pre></figure>',
          ),
      });
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'setTimeout', { value: () => 0, configurable: true });
  return copied;
}


async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('C6 codeBlockUi browser scripts', () => {
  let document: FakeDocument;
  let copied: string[];

  beforeEach(() => {
    document = new FakeDocument();
    copied = installGlobals(document);
  });

  it('delegates copy clicks so static server-rendered code blocks copy their text', async () => {
    Function(COPY_CODE_SCRIPT)();
    const figure = new FakeElement('figure', { class: 'code-block' });
    const button = new FakeElement('button', { class: 'copy-code' });
    const code = new FakeElement('code');
    code.textContent = 'static code';
    figure.appendChild(button);
    figure.appendChild(code);
    document.body.appendChild(figure);

    document.dispatchClick(button);
    await flushPromises();

    expect(copied).toEqual(['static code']);
  });

  it('binds preview only to toggle buttons and leaves pane clicks inert', () => {
    Function(PREVIEW_SCRIPT)();

    document.pane.dispatchClick();

    expect(document.fetchBodies).toEqual([]);
    expect(document.pane.innerHTML).toBe('');
  });

  it('lets preview-injected copy buttons use the delegated copy handler', async () => {
    Function(COPY_CODE_SCRIPT)();
    Function(PREVIEW_SCRIPT)();

    document.toggle.dispatchClick();
    await flushPromises();
    document.dispatchClick(document.previewCopyButton());
    await flushPromises();

    expect(document.fetchBodies).toEqual([
      'content=%60%60%60ts%0Aconst+x+%3D+1%3B%0A%60%60%60&actorId=ada&workspaceId=wsA',
    ]);
    expect(copied).toEqual(['const x = 1;']);
  });
});
