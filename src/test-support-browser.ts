import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/** Synthetic DOM/HTTP adapters execute the real public event handlers.
 * They do not establish browser rendering, SDK persistence or deployment proof. */
export class BrowserNode extends EventTarget {
  children: (BrowserNode | string)[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  checked = false;
  noValidate = false;
  value = '';
  className = '';
  href = '';
  resets = 0;

  constructor(readonly tagName: string) {
    super();
  }

  get textContent(): string {
    return this.children
      .map((child) => (typeof child === 'string' ? child : child.textContent))
      .join('');
  }
  set textContent(value: string) {
    this.children = [String(value)];
  }
  set innerHTML(_value: string) {
    throw new Error('This fixture requires safe text/element rendering.');
  }
  append(...children: (BrowserNode | string)[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: (BrowserNode | string)[]) {
    this.children = children;
  }
  all(): BrowserNode[] {
    return this.children.flatMap((child) =>
      typeof child === 'string' ? [] : [child, ...child.all()],
    );
  }
  matches(selector: string): boolean {
    if (selector.startsWith('#'))
      return this.attributes.get('id') === selector.slice(1);
    const field = /^input\[name="([^"]+)"\](:checked)?$/u.exec(selector);
    if (field)
      return (
        this.tagName === 'input' &&
        this.attributes.get('name') === field[1] &&
        (!field[2] || this.checked)
      );
    return this.tagName === selector;
  }
  querySelectorAll(selector: string): BrowserNode[] {
    const selectors = selector.split(',').map((part) => part.trim());
    return this.all().filter((node) =>
      selectors.some((part) => node.matches(part)),
    );
  }
  querySelector(selector: string): BrowserNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  reset() {
    ++this.resets;
    for (const field of this.all()) {
      if (['input', 'textarea', 'select'].includes(field.tagName)) {
        field.value = field.attributes.get('value') ?? '';
        field.checked = field.attributes.has('checked');
      }
    }
  }
  fire(type: string) {
    if (type === 'click' && this.disabled) return false;
    return this.dispatchEvent(new Event(type, { cancelable: true }));
  }
}

function documentFromTemplate(template: string) {
  const root = new BrowserNode('document');
  const stack = [root];
  const voidTags = new Set(['input', 'img', 'link', 'meta', 'br', 'hr']);
  const tags = /<(\/?)([a-z][a-z0-9-]*)([^>]*?)>/giu;
  for (const match of template.matchAll(tags)) {
    const tag = match[2]?.toLowerCase() ?? '';
    if (match[1]) {
      const last = stack.findLastIndex((node) => node.tagName === tag);
      if (last > 0) stack.splice(last);
      continue;
    }
    const node = new BrowserNode(tag);
    const attributes = match[3] ?? '';
    for (const attr of attributes.matchAll(/([\w:-]+)(?:="([^"]*)")?/gu)) {
      if (attr[1]) {
        node.attributes.set(attr[1], attr[2] ?? '');
        if (attr[1].startsWith('data-'))
          node.dataset[attr[1].slice(5).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())] = attr[2] ?? '';
      }
    }
    node.hidden = node.attributes.has('hidden');
    node.disabled = node.attributes.has('disabled');
    node.checked = node.attributes.has('checked');
    node.noValidate = node.attributes.has('novalidate');
    node.value = node.attributes.get('value') ?? '';
    stack.at(-1)?.append(node);
    if (!voidTags.has(tag) && !attributes.endsWith('/')) stack.push(node);
  }
  for (const select of root.all().filter((node) => node.tagName === 'select')) {
    const options = select.all().filter((node) => node.tagName === 'option');
    select.value =
      (options.find((node) => node.attributes.has('selected')) ?? options[0])
        ?.value ?? '';
  }
  return Object.assign(root, {
    createElement(tag: string) {
      return new BrowserNode(tag.toLowerCase());
    },
  });
}

export interface BrowserCall {
  readonly path: string;
  readonly method: string;
  readonly body?: string;
  readonly headers: Headers;
  readonly signal?: AbortSignal;
}
export interface BrowserResponse {
  readonly status?: number;
  readonly body: unknown;
  readonly headers?: HeadersInit;
  readonly json?: () => Promise<unknown>;
}

const disposers = new Set<() => void>();
export function disposeSupportBrowsers() {
  for (const dispose of disposers) dispose();
  disposers.clear();
}

async function withAbort<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(new DOMException('Aborted browser request', 'AbortError'));
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function supportBrowser(
  surface: 'create' | 'customer' | 'staff' | 'queue',
  respond: (call: BrowserCall) => BrowserResponse | Promise<BrowserResponse>,
) {
  const paths = {
    create: ['feedback.js', 'feedback.astro', '/feedback/'],
    customer: [
      'feedback-ticket.js',
      'feedback/ticket.astro',
      '/feedback/ticket/',
    ],
    staff: [
      'staff-support-ticket.js',
      'staff/support/ticket.astro',
      '/staff/support/ticket/',
    ],
    queue: ['staff-support.js', 'staff/support.astro', '/staff/support/'],
  } as const;
  const [script, page, path] = paths[surface];
  const document = documentFromTemplate(
    readFileSync(new URL(`./pages/${page}`, import.meta.url), 'utf8'),
  );
  let reloads = 0;
  const window = Object.assign(new EventTarget(), {
    location: {
      href: `https://pegma.dev${path}?id=ticket-example`,
      reload: () => {
        ++reloads;
      },
    },
  });
  const calls: BrowserCall[] = [];
  let activeReads = 0;
  class BrowserJsonResponse extends Response {
    constructor(
      body: string | undefined,
      init: ResponseInit,
      readonly reader?: () => Promise<unknown>,
      readonly signal?: AbortSignal,
    ) {
      super(body, init);
    }
    override async json(): Promise<unknown> {
      ++activeReads;
      try {
        return await withAbort(
          this.reader ? this.reader() : super.json(),
          this.signal,
        );
      } finally {
        --activeReads;
      }
    }
  }
  class BrowserFormData {
    constructor(readonly form: BrowserNode) {}
    get(name: string) {
      return (
        this.form.all().find((node) => node.attributes.get('name') === name)
          ?.value ?? null
      );
    }
  }
  runInNewContext(
    readFileSync(new URL(`../public/${script}`, import.meta.url), 'utf8'),
    {
      document,
      window,
      URL,
      URLSearchParams,
      Headers,
      Date,
      setTimeout,
      clearTimeout,
      AbortController,
      FormData: BrowserFormData,
      crypto: { randomUUID },
      fetch: async (request: string, init: RequestInit = {}) => {
        if (init.body !== undefined && typeof init.body !== 'string')
          throw new Error('Unexpected browser request body.');
        const call: BrowserCall = {
          path: request,
          method: init.method ?? 'GET',
          ...(typeof init.body === 'string' ? { body: init.body } : {}),
          headers: new Headers(init.headers),
          ...(init.signal ? { signal: init.signal } : {}),
        };
        calls.push(call);
        ++activeReads;
        try {
          const response = await withAbort(
            Promise.resolve().then(() => respond(call)),
            call.signal,
          );
          return new BrowserJsonResponse(
            JSON.stringify(response.body),
            {
              status: response.status ?? 200,
              ...(response.headers ? { headers: response.headers } : {}),
            },
            response.json,
            call.signal,
          );
        } finally {
          --activeReads;
        }
      },
    },
    { filename: script },
  );
  const dispose = () => {
    window.dispatchEvent(new Event('pagehide'));
    disposers.delete(dispose);
  };
  disposers.add(dispose);
  return {
    document,
    window,
    calls,
    dispose,
    get reloads() {
      return reloads;
    },
    node(id: string) {
      const node = document.querySelector(`#${id}`);
      if (!node) throw new Error(`Template has no #${id}.`);
      return node;
    },
    /** Models required-field validation BEFORE submit, for the actual forms
     * loaded above. This is not a browser or a complete HTML validity engine. */
    nativeSubmit(formId: string) {
      const form = document.querySelector(`#${formId}`);
      if (!form || form.tagName !== 'form')
        throw new Error(`Template has no form #${formId}.`);
      const submitter = form.querySelectorAll('button').find((node) =>
        (node.attributes.get('type') ?? 'submit') === 'submit',
      );
      if (!submitter || submitter.disabled)
        return { dispatched: false, blockedBy: 'disabled' };
      if (!form.noValidate && !submitter.attributes.has('formnovalidate')) {
        const required = form.querySelectorAll('input, textarea, select').filter(
          (node) => node.attributes.has('required') && !node.disabled,
        );
        const missing = required.some((node) => {
          const type = node.attributes.get('type');
          if (type === 'checkbox') return !node.checked;
          if (type === 'radio')
            return !form.querySelectorAll('input').some((peer) =>
              peer.attributes.get('name') === node.attributes.get('name') &&
              peer.checked,
            );
          return node.value === '';
        });
        if (missing) return { dispatched: false, blockedBy: 'required' };
      }
      form.fire('submit');
      return { dispatched: true, blockedBy: null };
    },
    mode(value: string) {
      for (const node of document.all()) {
        if (node.attributes.get('name') === 'composeMode')
          node.checked = node.value === value;
      }
    },
    async until(predicate: () => boolean) {
      for (let turn = 0; turn < 250; ++turn) {
        if (predicate()) return;
        await Promise.resolve();
      }
      throw new Error(
        'Browser fixture did not reach the expected event state.',
      );
    },
    async drain() {
      let idleTurns = 0;
      for (let turn = 0; turn < 250; ++turn) {
        await Promise.resolve();
        idleTurns = activeReads === 0 ? idleTurns + 1 : 0;
        if (idleTurns === 5) return;
      }
      throw new Error('Browser fixture still has unresolved HTTP work.');
    },
    async tick() {
      for (let turn = 0; turn < 30; ++turn) await Promise.resolve();
    },
  };
}

export function browserGate<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Gate not initialized');
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error('Gate not initialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
