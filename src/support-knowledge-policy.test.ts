import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const template = readFileSync(
  new URL('./pages/staff/knowledge.astro', import.meta.url),
  'utf8',
);
const script =
  '(async()=>{' +
  readFileSync(
    new URL('../public/staff-knowledge.js', import.meta.url),
    'utf8',
  ) +
  '})()';
// Executes the real host script against actual template IDs and synthetic HTTP/DOM ports.
class Node extends EventTarget {
  children: Node[] = [];
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  textContent = '';
  constructor(
    readonly tagName: string,
    readonly id = '',
  ) {
    super();
  }
  append(...nodes: Node[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Node[]) {
    this.children = nodes;
    this.textContent = '';
  }
  querySelectorAll(_selector: string): Node[] {
    return this.children;
  }
  setAttribute(_key: string, _value: string) {}
  remove() {}
}
function gate() {
  let release = () => {};
  const pending = new Promise<void>((done) => {
    release = done;
  });
  return { pending, release };
}
function fixture() {
  const nodes = new Map<string, Node>();
  for (const match of template.matchAll(
    /<([a-z][a-z0-9-]*)[^>]*\bid="([^"]+)"[^>]*>/giu,
  )) {
    const n = new Node(match[1]!, match[2]!);
    n.hidden = match[0].includes(' hidden');
    nodes.set(n.id, n);
  }
  const panel = nodes.get('kb-panel')!;
  panel.children = [...nodes.values()].filter((n) => n !== panel);
  const root = new Node('main');
  root.dataset.knowledgeSurface = 'staff';
  const document = {
    querySelector(selector: string) {
      return selector === '[data-knowledge-surface]'
        ? root
        : (nodes.get(selector.slice(1)) ?? null);
    },
    createElement(tag: string) {
      return new Node(tag);
    },
  };
  const calls: { operation: string; input: any }[] = [];
  let permission = true;
  let denyPreview = false;
  let blocker: ReturnType<typeof gate> | null = null;
  let policy = {
    portal: {
      enabled: true,
      audience: { kind: 'permission', permission: 'audience.portal' },
    },
    bot: { enabled: false },
  };
  let proposed: any;
  const preview = { generation: 4, preview: { token: 'Opaque:ExactPreview' } };
  const confirm = vi.fn(() => true);
  const context: any = {
    document,
    URL,
    URLSearchParams,
    Headers,
    TextEncoder,
    crypto: { randomUUID: () => 'Command:ExactCase' },
    window: {
      confirm,
      location: { pathname: '/account/knowledge-admin/', search: '' },
    },
    prepareAccountTools: async () => true,
    fetch: async (path: string, init: any = {}) => {
      if (path.endsWith('/state'))
        return new Response(
          JSON.stringify({
            csrfToken: 'csrf',
            attesterId: 'Staff:A',
            permissions: { collectionManage: permission },
          }),
        );
      const packet = JSON.parse(init.body);
      calls.push(packet);
      if (packet.operation === 'getCollection')
        return new Response(
          JSON.stringify({
            generation: 4,
            collection: { id: 'Collection:A', policy },
          }),
        );
      if (packet.operation === 'previewCollectionPolicy') {
        proposed = packet.input.uses;
        if (blocker) await blocker.pending;
        return new Response(
          JSON.stringify(denyPreview ? { error: 'forbidden' } : preview),
          { status: denyPreview ? 403 : 200 },
        );
      }
      if (packet.operation === 'updateCollectionPolicy') {
        policy = proposed;
        return new Response('{}');
      }
      throw new Error('Unexpected policy test operation ' + packet.operation);
    },
  };
  runInNewContext(script, context);
  const settle = () => new Promise<void>((done) => setImmediate(done));
  const node = (id: string) => {
    const n = nodes.get(id);
    if (!n) throw new Error('Missing actual template ID ' + id);
    return n;
  };
  const fire = async (id: string, event = 'submit') => {
    node(id).dispatchEvent(new Event(event, { cancelable: true }));
    await settle();
  };
  return {
    node,
    calls,
    confirm,
    fire,
    settle,
    preview,
    get policy() {
      return policy;
    },
    block() {
      blocker = gate();
      return blocker;
    },
    deny() {
      denyPreview = true;
    },
    async load() {
      await settle();
      node('kb-collection-id').value = 'Collection:A';
      await fire('kb-collection-form');
    },
  };
}
describe('independent portal and bot audience controls', () => {
  it('loads current bot state and previews an independent bot audience before exact approval', async () => {
    const f = fixture();
    await f.load();
    expect(f.node('kb-bot-enabled').checked).toBe(false);
    expect(f.node('kb-portal-enabled').checked).toBe(true);
    f.node('kb-bot-enabled').checked = true;
    f.node('kb-bot-permission').value = 'audience.bot';
    await f.fire('kb-portal-form');
    const packet = f.calls.find(
      (c) => c.operation === 'previewCollectionPolicy',
    )!;
    expect(packet.input).toEqual({
      collectionId: 'Collection:A',
      uses: {
        portal: {
          enabled: true,
          audience: { kind: 'permission', permission: 'audience.portal' },
        },
        bot: {
          enabled: true,
          audience: { kind: 'permission', permission: 'audience.bot' },
        },
      },
    });
    expect(f.policy.bot.enabled).toBe(false);
    expect(f.calls.some((c) => c.operation === 'updateCollectionPolicy')).toBe(
      false,
    );
    await f.fire('kb-policy-apply', 'click');
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith(
      'Apply this exact reviewed audience policy?',
    );
    expect(
      f.calls.find((c) => c.operation === 'updateCollectionPolicy')?.input,
    ).toMatchObject({
      collectionId: 'Collection:A',
      expectedGeneration: 4,
      preview: f.preview.preview,
    });
    expect(f.policy.portal).toEqual(packet.input.uses.portal);
  });
  it('can disable portal while preserving an explicitly chosen bot audience', async () => {
    const f = fixture();
    await f.load();
    f.node('kb-portal-enabled').checked = false;
    f.node('kb-bot-enabled').checked = true;
    f.node('kb-bot-permission').value = 'audience.bot';
    await f.fire('kb-portal-form');
    expect(f.calls.at(-1)?.input.uses).toEqual({
      portal: { enabled: false },
      bot: {
        enabled: true,
        audience: { kind: 'permission', permission: 'audience.bot' },
      },
    });
  });
  it('invalidates a ready preview whenever either audience field changes', async () => {
    const f = fixture();
    await f.load();
    await f.fire('kb-portal-form');
    expect(f.node('kb-policy-apply').hidden).toBe(false);
    f.node('kb-bot-enabled').checked = true;
    await f.fire('kb-bot-enabled', 'change');
    expect(f.node('kb-policy-apply').hidden).toBe(true);
    await f.fire('kb-policy-apply', 'click');
    expect(f.calls.some((c) => c.operation === 'updateCollectionPolicy')).toBe(
      false,
    );
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it('drops a delayed preview when fields change during its await', async () => {
    const f = fixture();
    await f.load();
    const held = f.block();
    f.node('kb-portal-form').dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await f.settle();
    f.node('kb-bot-permission').value = 'audience.new';
    await f.fire('kb-bot-permission', 'input');
    held.release();
    await f.settle();
    expect(f.node('kb-policy-apply').hidden).toBe(true);
    expect(f.node('kb-status').textContent).toContain('Preview them again');
  });
  it('does not issue a preview for a missing enabled bot audience', async () => {
    const f = fixture();
    await f.load();
    f.node('kb-bot-enabled').checked = true;
    f.node('kb-bot-permission').value = ' ';
    await f.fire('kb-portal-form');
    expect(f.calls.some((c) => c.operation === 'previewCollectionPolicy')).toBe(
      false,
    );
  });
  it('clears policy state on current permission denial without applying anything', async () => {
    const f = fixture();
    await f.load();
    f.deny();
    await f.fire('kb-portal-form');
    expect(f.node('kb-panel').hidden).toBe(true);
    expect(f.calls.some((c) => c.operation === 'updateCollectionPolicy')).toBe(
      false,
    );
  });
});
