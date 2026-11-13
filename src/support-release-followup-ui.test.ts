import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { authenticate } from '../worker/src/api-auth';
import { IDENTITY_ISSUER } from '../worker/src/identity-api';
import { createSupportReleaseFollowupFixture } from '../worker/src/support-release-followup-fixtures';
import type { EngineeringHttpActor } from '../worker/src/support-engineering-http-fixtures';
import { BrowserNode } from './test-support-browser';

interface Panel {
  showTicket(value: { ticketId: string; actorSubject: string }): void;
  suspend(): void;
  hasPending(): boolean;
  perform(action: string): Promise<void>;
}
class PanelNode extends BrowserNode {
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
}
async function harness() {
  const f = await createSupportReleaseFollowupFixture();
  const work = await f.prepare();
  const root = new PanelNode('section');
  const writes: { operation: string; body: string; status?: number }[] = [];
  const state = {
    actor: 'staff' as EngineeringHttpActor,
    ids: 0,
    fault: undefined as
      ((operation: string, response: Response) => Promise<void>) | undefined,
    busy: false,
  };
  const ownerChanges: unknown[] = [];
  const vm: Record<string, unknown> = {
    document: { createElement: (tag: string) => new PanelNode(tag) },
    setTimeout,
    clearTimeout,
    Date,
  };
  runInNewContext(
    readFileSync(
      new URL('../public/staff-support-followup.js', import.meta.url),
      'utf8',
    ),
    vm,
  );
  const factory = vm.PegmaSupportFollowup as {
    createPanel(options: unknown): Panel;
  };
  function incoming(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Cookie', f.f.cookies.get(state.actor)!);
    if (init.method === 'POST') {
      headers.set('Origin', IDENTITY_ISSUER);
      headers.set('Sec-Fetch-Site', 'same-origin');
    }
    return new Request(IDENTITY_ISSUER + path, { ...init, headers });
  }
  async function request(path: string, init: RequestInit = {}) {
    const operation = path.split('/').at(-1)!;
    const response = await f.api(incoming(path, init));
    if (init.method === 'POST')
      writes.push({
        operation,
        body: String(init.body),
        status: response.status,
      });
    await state.fault?.(operation, response);
    if (!response.ok)
      throw Object.assign(new Error('request_failed'), {
        status: response.status,
      });
    return response.json();
  }
  const panel = factory.createPanel({
    root,
    request,
    async readSession() {
      const value = await authenticate(
        incoming('/api/identity/session'),
        f.f.options,
      );
      if (value === null)
        throw Object.assign(new Error('signed_out'), { status: 401 });
      return { subject: value.link.subject, csrfToken: value.csrfToken };
    },
    readCurrentTicket: (ticketId: string) =>
      request('/api/support/admin/tickets/' + ticketId),
    commandId: () =>
      '15df8c75-33ac-4e45-a144-' + String(++state.ids).padStart(12, '0'),
    onPendingChange: (owner: unknown) => ownerChanges.push(owner),
    onBusyChange: (value: boolean) => {
      state.busy = value;
    },
  });
  const field = (name: string) => {
    const node = root
      .all()
      .find((entry) => entry.dataset.followupField === name);
    if (node === undefined)
      throw new Error('Expected actual panel field ' + name);
    return node;
  };
  const button = (name: string) => {
    const node = root
      .all()
      .find((entry) => entry.dataset.followupAction === name);
    if (node === undefined)
      throw new Error('Expected actual panel action ' + name);
    return node;
  };
  const open = () =>
    panel.showTicket({
      ticketId: work.ticketId,
      actorSubject: f.f.principals[state.actor],
    });
  async function read() {
    open();
    field('workId').value = work.workId;
    await panel.perform('work');
  }
  return {
    f,
    work,
    panel,
    root,
    state,
    writes,
    ownerChanges,
    field,
    button,
    open,
    read,
  };
}

describe('release follow-up panel with actual SDK and current browser authority', () => {
  it('settles observe with the actual public SDK head generation and current handler envelope', async () => {
    const h = await harness();
    let observed: any;
    h.state.fault = async (operation, response) => {
      if (operation === 'observe') observed = await response.clone().json();
    };
    h.open();
    h.field('repositoryId').value = h.f.identity.association.repositoryId;
    h.field('issueId').value = h.f.identity.association.issueId;
    h.field('inputReference').value = h.f.identity.inputReference;
    await h.panel.perform('observe');
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.status).toBe(200);
    expect(observed.operation).toBe('observe');
    expect(Number.isSafeInteger(observed.result.headGeneration)).toBe(true);
    expect(observed.result.outcome).toBe('unchanged');
    expect(h.panel.hasPending()).toBe(false);
    expect(h.ownerChanges.at(-1)).toBeNull();
  });
  it('keeps every control inert until a current ticket is supplied and renders all data as text', async () => {
    const h = await harness();
    expect(h.button('post').disabled).toBe(true);
    await h.panel.perform('post');
    expect(h.writes).toEqual([]);
    await h.read();
    expect(h.button('post').disabled).toBe(false);
    expect(h.root.textContent).toContain('deployed export fix');
    expect(h.button('post').attributes.get('type') ?? 'button').toBe('button');
  });

  it('posts the pinned complete bundle exactly once through the real registered handler', async () => {
    const h = await harness();
    await h.read();
    await h.panel.perform('post');
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.status).toBe(200);
    const body = JSON.parse(h.writes[0]!.body);
    expect(body.bundleHash).toBe(h.work.preparedBundle!.bundleHash);
    expect(body.expectedTicketRevision).toBe(h.work.acceptedTicketRevision);
    expect(h.panel.hasPending()).toBe(false);
    expect(h.ownerChanges.at(-1)).toBeNull();
    expect(h.f.state.modelCalls).toBe(1);
  });

  it('keeps an accepted-but-lost ACK and retries identical bytes without rebuilding it from a current draft', async () => {
    const h = await harness();
    await h.read();
    let lose = true;
    h.state.fault = async (operation, response) => {
      if (operation === 'post' && response.status === 200 && lose) {
        lose = false;
        throw new Error('Synthetic dropped actual committed response');
      }
    };
    await h.panel.perform('post');
    expect(h.panel.hasPending()).toBe(true);
    const committed = await h.f.rows();
    h.f.state.proofAvailable = false;
    h.open();
    h.field('content').value =
      'An invalid separate new draft must not replace the retained packet.';
    await h.panel.perform('exact-retry');
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1]!.body).toBe(h.writes[0]!.body);
    expect(h.panel.hasPending()).toBe(false);
    expect(await h.f.rows()).toEqual(committed);
  });

  it.each([401, 403, 404, 429, 503])(
    'retains an unresolved owner after refusal %s and clears private content',
    async (status) => {
      const h = await harness();
      await h.read();
      h.state.fault = async (operation) => {
        if (operation === 'post')
          throw Object.assign(
            new Error('Synthetic transport refusal after actual command'),
            { status },
          );
      };
      await h.panel.perform('post');
      expect(h.writes).toHaveLength(1);
      expect(h.panel.hasPending()).toBe(true);
      expect(h.field('content').value).toBe('');
      expect(h.button('observe').disabled).toBe(true);
      h.state.fault = undefined;
      h.open();
      // 429's finite wait is retained; this case asserts ownership rather than
      // advancing a real session clock or weakening the request deadline.
      if (status !== 429) {
        await h.panel.perform('exact-retry');
        expect(h.writes[1]!.body).toBe(h.writes[0]!.body);
        expect(h.panel.hasPending()).toBe(false);
      }
      h.panel.suspend();
    },
  );

  it('keeps A pending across A to B to A without exposing or replaying the packet as B', async () => {
    const h = await harness();
    await h.read();
    h.state.fault = async (operation) => {
      if (operation === 'post') throw new Error('Synthetic lost ACK');
    };
    await h.panel.perform('post');
    expect(h.panel.hasPending()).toBe(true);
    h.state.actor = 'peer';
    h.open();
    expect(h.button('exact-retry').disabled).toBe(true);
    expect(h.field('workId').value).toBe('');
    await h.panel.perform('exact-retry');
    expect(h.writes).toHaveLength(1);
    h.state.actor = 'staff';
    h.state.fault = undefined;
    h.open();
    await h.panel.perform('exact-retry');
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1]!.body).toBe(h.writes[0]!.body);
    expect(h.panel.hasPending()).toBe(false);
  });

  it('does not settle a matching-actor packet from a mismatched successful ACK', async () => {
    const h = await harness();
    await h.read();
    h.state.fault = async (operation, response) => {
      if (operation === 'post' && response.status === 200) {
        const actual = await response.json();
        Object.assign(response, {
          json: async () => ({ ...actual, commandId: 'different-command' }),
        });
      }
    };
    await h.panel.perform('post');
    expect(h.panel.hasPending()).toBe(true);
    expect(h.writes).toHaveLength(1);
  });

  it('requires local observation fields before creating or sending a retained intent', async () => {
    const h = await harness();
    h.open();
    await h.panel.perform('observe');
    expect(h.writes).toEqual([]);
    expect(h.panel.hasPending()).toBe(false);
    expect(h.root.textContent).toContain('Enter the accepted repository ID');
  });
});
