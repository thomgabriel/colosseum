// @vitest-environment happy-dom
import { solanaVaultAddress } from '@colosseum/sdk';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, fire, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { useAccount } from '../account/AccountProvider';
import { withAccount } from '../account/test/screen';
import { recallOrder } from '../order/order-record';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { PublishScreen } from './PublishScreen';
import { readPublishVault } from './publish-vault';
import {
  FAMILY_ID,
  familyOf,
  limitsOf,
  ORDER_ID,
  publishOrder,
  recipeOf,
  SOLANA,
  USER,
  vaultOf,
  WEIGHTS,
} from './test/fixtures';
import { VaultScreen } from './VaultScreen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));
vi.mock('./publish-vault', async (original) => ({
  ...(await original<typeof import('./publish-vault')>()),
  readPublishVault: vi.fn(),
}));
const read = vi.mocked(readPublishVault);
const en = dictionary('en');
const first = solanaVaultAddress('529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW', SOLANA, '42');
const second = solanaVaultAddress('529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW', SOLANA, '43');
const snapshots = (address = first, components = WEIGHTS) => ({
  kind: 'read' as const,
  source: 'chain' as const,
  components,
  strategy: JSON.stringify(components),
  value: {
    chain: 'solana' as const,
    name: 'Solana',
    mode: 'live' as const,
    provenance: 'sandbox' as const,
    prices: [],
    disclaimer: 'd',
    vault: {
      ...vaultOf({ address, basketId: address === first ? '42' : '43' }),
      provenance: 'sandbox' as const,
    },
  },
});
const button = (host: HTMLElement, name = en.shared.publish.review) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(name)) as HTMLElement;
function field(host: HTMLElement, label: string) {
  const id = [...host.querySelectorAll('label')].find((l) => l.textContent === label)?.htmlFor;
  return find<HTMLInputElement>(host, `#${CSS.escape(id ?? '')}`);
}
function SwitchChain() {
  const { choose } = useAccount();
  return createElement(
    'button',
    { type: 'button', onClick: () => choose('robinhood') },
    'Switch chain',
  );
}
function api(
  options: {
    order?: () => Promise<Response>;
    family?: () => Response;
    vaults?: ReturnType<typeof vaultOf>[];
    publicOwner?: string;
    /** The vault's page reads it with a target: a strategy there is to share. */
    targeted?: boolean;
    /** The chain the person's new plans start on; Solana unless said. */
    chain?: string;
    /** The chains a wallet of theirs signs on; both unless said. */
    chainOptions?: string[];
    /** Answers GET /v1/shared/limits; the chain's own rules unless said. */
    limits?: () => Response;
  } = {},
) {
  let chain = options.chain ?? 'solana';
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  portStore.setApi(async (path, init) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const person = {
      userId: portStore.get().userId,
      wallets: EMBEDDED,
      chain,
      chainSource: 'picked',
      chainOptions: options.chainOptions ?? [],
    };
    if (path === '/v1/me') return json(person);
    if (path === '/v1/me/chain') {
      chain = JSON.parse(String(init?.body)).chain;
      return json({ ...person, chain });
    }
    if (path === '/v1/portfolio')
      return json({
        chains: [
          {
            chain: 'solana',
            name: 'Solana',
            mode: 'live',
            provenance: 'sandbox',
            prices: [],
            vaults: (
              options.vaults ?? [
                vaultOf({ address: first }),
                vaultOf({ address: second, basketId: '43' }),
              ]
            ).map((v) => ({ ...v, provenance: 'sandbox' })),
          },
        ],
        disclaimer: 'd',
      });
    if (path.startsWith('/v1/shared/limits?chain='))
      return options.limits?.() ?? json(limitsOf(path.split('=')[1] ?? ''));
    if (path.startsWith('/v1/indexes/'))
      return options.family?.() ?? json({ error: 'missing' }, 404);
    if (path.startsWith('/v1/vaults/'))
      return json({
        ...snapshots().value,
        vault: {
          ...snapshots().value.vault,
          owner: options.publicOwner ?? SOLANA,
          ...(options.targeted
            ? {
                positions: [
                  {
                    asset: 'solana:spyx',
                    raw: '0',
                    multiplier: '1',
                    display: '0',
                    targetBps: 10_000,
                    lastKeeperAt: null,
                    valueUsd: '0',
                    weightBps: 0,
                    driftBps: -10_000,
                  },
                ],
              }
            : {}),
        },
      });
    if (path === '/v1/orders') return options.order?.() ?? json(publishOrder());
    return json({ error: 'missing' }, 404);
  });
  return calls;
}
async function show() {
  const host = await mount(
    withAccount(
      'en',
      createElement('div', null, createElement(PublishScreen), createElement(SwitchChain)),
    ),
  );
  await settle(50);
  await type(field(host, en.shared.publish.name), 'Three of the largest');
  await settle(350);
  await settle(20);
  return host;
}
async function select(host: HTMLElement, address: string) {
  const el = find<HTMLSelectElement>(host, 'select');
  el.value = address;
  await fire(el, new Event('change', { bubbles: true }));
  await settle(10);
}
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/products/publish');
  router.push.mockClear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  read.mockReset().mockImplementation(async (_api, at) => snapshots(at.address));
});
afterEach(unmountAll);

describe('sharing a selected vault strategy', () => {
  it('offers Publish as a portfolio to the vault’s owner on the vault’s own chain, whatever chain new plans start on', async () => {
    api({ targeted: true });
    const host = await mount(
      withAccount(
        'en',
        createElement(
          'div',
          null,
          createElement(VaultScreen, { chain: 'solana', address: first }),
          createElement(SwitchChain),
        ),
      ),
    );
    await settle(30);
    // the link names the vault's chain, so the form opens on it
    const href = `/products/publish?vault=${encodeURIComponent(first)}&chain=solana`;
    expect(find(host, '[data-ui="vault-share-strategy"]').getAttribute('href')).toBe(href);
    // new plans now start on Robinhood Chain: the Solana vault is still theirs to share
    await click(button(host, 'Switch chain'));
    await settle(30);
    expect(find(host, '[data-ui="vault-share-strategy"]').getAttribute('href')).toBe(href);
    await act(async () => {
      portStore.set(fakePort());
    });
    expect(host.querySelector('[data-ui="vault-share-strategy"]')).toBeNull();
  });
  it('offers none for a vault with no targets: a strategy is its targets (gate VAULT-PAGE-ACTIONS)', async () => {
    api();
    const host = await mount(
      withAccount('en', createElement(VaultScreen, { chain: 'solana', address: first })),
    );
    await settle(30);
    expect(host.querySelector('[data-ui="vault-more"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="vault-share-strategy"]')).toBeNull();
  });
  it('does not offer Publish as a portfolio where no wallet of the person signs on the vault’s chain', async () => {
    api({ chainOptions: ['robinhood'], targeted: true });
    const host = await mount(
      withAccount('en', createElement(VaultScreen, { chain: 'solana', address: first })),
    );
    await settle(30);
    expect(host.querySelector('[data-ui="vault"], [data-ui="vault-screen"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="vault-share-strategy"]')).toBeNull();
  });
  it('opens the form on the chain the link names, though new plans start on another', async () => {
    api({ chain: 'robinhood' });
    window.history.replaceState(
      null,
      '',
      `/products/publish?vault=${encodeURIComponent(second)}&chain=solana`,
    );
    const host = await show();
    expect(find<HTMLSelectElement>(host, 'select').value).toBe(second);
    expect(host.querySelectorAll('[data-ui="publish-row"]')).toHaveLength(3);
  });
  it('does not offer Publish as a portfolio on another person’s public vault', async () => {
    api({ publicOwner: '11111111111111111111111111111111', targeted: true });
    const host = await mount(
      withAccount('en', createElement(VaultScreen, { chain: 'solana', address: first })),
    );
    await settle(30);
    expect(host.querySelector('[data-ui="vault-share-strategy"]')).toBeNull();
  });
  it('publishes exactly reviewed target weights, separate from holdings, without private chat or manual rows', async () => {
    const calls = api();
    const host = await show();
    expect(host.querySelectorAll('[data-ui="publish-row"]')).toHaveLength(3);
    expect(host.querySelectorAll('input')).toHaveLength(2);
    expect(host.querySelectorAll('select')).toHaveLength(1);
    expect(host.textContent).toContain(en.shared.publish.holdings);
    await click(button(host));
    await settle(10);
    expect(calls.find((c) => c.path === '/v1/orders')?.body).toMatchObject({
      recipes: [{ chain: 'solana', components: WEIGHTS.map((c) => ({ kind: 'asset', ...c })) }],
      copy: '',
    });
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({
      kind: 'publish',
      components: WEIGHTS,
      action: 'publish',
      version: 1,
    });
    expect(router.push).toHaveBeenCalledOnce();
  });
  it('marks only the card with figures as not live, once, and names where the targets were read (the UI audit, G9)', async () => {
    api();
    const host = await show();
    const form = find(host, `section[aria-label="${en.shared.publish.about}"]`);
    expect(form.querySelector('[data-ui="sample-tag"]')).toBeNull();
    const assets = find(host, `section[aria-label="${en.shared.publish.assets}"]`);
    const tags = [...assets.querySelectorAll('[data-ui="sample-tag"]')].map((t) => t.textContent);
    expect(tags).toHaveLength(1);
    expect([en.shell.testNetworkLine, en.shell.mockAnnounce]).toContain(tags[0]);
    // and no line of where the targets were read from (gate SOURCE-LINES)
    expect(assets.textContent).not.toMatch(/read from/i);
  });
  it('preserves the existing reviewed update terms after rereading the current recipe', async () => {
    let version = 2;
    const calls = api({
      family: () =>
        json({
          family: familyOf(FAMILY_ID, {
            recipes: [recipeOf({ creator: SOLANA, active: { ...recipeOf().active, version } })],
          }),
          disclaimer: 'd',
        }),
    });
    const host = await show();
    version = 3;
    await click(button(host));
    await settle(10);
    expect(calls.filter((c) => c.path === '/v1/orders')).toHaveLength(0);
    expect(host.textContent).toContain(en.shared.refusal.versionChanged);
    await click(button(host));
    await settle(10);
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({
      kind: 'publish',
      action: 'update',
      version: 4,
      components: WEIGHTS,
    });
  });
  it('refreshes a changed source strategy and requires another review instead of publishing stale displayed weights', async () => {
    const calls = api();
    const host = await show();
    const next = WEIGHTS.map((t, i) => ({ ...t, weightBps: [3500, 3500, 3000][i] ?? t.weightBps }));
    read.mockResolvedValue(snapshots(first, next));
    await click(button(host));
    await settle(10);
    expect(calls.filter((c) => c.path === '/v1/orders')).toHaveLength(0);
    expect(host.textContent).toContain(en.shared.publish.strategyChanged);
    expect(host.querySelector('[data-ui="publish-row"]')?.textContent).toContain('35%');
    await click(button(host));
    await settle(10);
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({ components: next });
  });
  it('rechecks the full snapshot when a zero allocation becomes positive', async () => {
    const calls = api();
    const initial = {
      ...snapshots(),
      strategy: JSON.stringify([...WEIGHTS, { asset: 'solana:usdy', weightBps: 0 }]),
    };
    read.mockResolvedValue(initial);
    const host = await show();
    const next = [
      { asset: 'solana:spyx', weightBps: 3500 },
      ...WEIGHTS.slice(1),
      { asset: 'solana:usdy', weightBps: 500 },
    ];
    read.mockResolvedValue(snapshots(first, next));
    await click(button(host));
    await settle(10);
    expect(calls.filter((c) => c.path === '/v1/orders')).toHaveLength(0);
    expect(host.textContent).toContain(en.shared.publish.strategyChanged);
    expect(host.querySelectorAll('[data-ui="publish-row"]')).toHaveLength(4);
  });
  it('refuses a source whose structural zero cash became positive before review', async () => {
    const calls = api();
    read.mockResolvedValue({
      ...snapshots(),
      strategy: JSON.stringify([...WEIGHTS, { asset: 'solana:usdc', weightBps: 0 }]),
    });
    const host = await show();
    read.mockResolvedValue({ kind: 'unsupported' });
    await click(button(host));
    await settle(10);
    expect(calls.filter((c) => c.path === '/v1/orders')).toHaveLength(0);
    expect(host.textContent).toContain(en.shared.publish.sourceProblems.unsupported);
  });
  it.each(['account', 'chain', 'vault', 'network'] as const)(
    'ignores a late placement after %s changes',
    async (context) => {
      let release!: (value: Response) => void;
      const wait = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const calls = api({ order: () => wait });
      const host = await show();
      await click(button(host));
      await settle(10);
      await click(button(host, en.shared.publish.reviewing));
      expect(calls.filter((c) => c.path === '/v1/orders')).toHaveLength(1);
      if (context === 'account')
        await act(async () => {
          portStore.set(signedInPort(EMBEDDED, { userId: 'another-person' }));
        });
      else if (context === 'chain') await click(button(host, 'Switch chain'));
      else if (context === 'network')
        await act(async () => {
          portStore.set(signedInPort(EMBEDDED, { userId: USER }, 'live'));
        });
      else await select(host, second);
      await settle(20);
      release(json(publishOrder()));
      await settle(20);
      expect(recallOrder(ORDER_ID, USER)).toBeNull();
      expect(router.push).not.toHaveBeenCalled();
    },
  );
  it('ignores a late source read after the selected vault changes', async () => {
    let release!: (value: ReturnType<typeof snapshots>) => void;
    const wait = new Promise<ReturnType<typeof snapshots>>((resolve) => {
      release = resolve;
    });
    api();
    read.mockImplementation(async (_api, at) => (at.address === first ? wait : snapshots(second)));
    const host = await show();
    await select(host, second);
    release(snapshots(first, [{ asset: 'solana:spyx', weightBps: 10000 }]));
    await settle(20);
    expect(find(host, '[data-ui="publish-source"]').textContent).toContain(second);
    expect(host.querySelectorAll('[data-ui="publish-row"]')).toHaveLength(3);
  });
  it.each(['account', 'chain', 'network'] as const)(
    'ignores a late source read after %s changes',
    async (context) => {
      let release!: (value: ReturnType<typeof snapshots>) => void;
      const wait = new Promise<ReturnType<typeof snapshots>>((resolve) => {
        release = resolve;
      });
      api();
      read.mockImplementationOnce(() => wait).mockResolvedValue({ kind: 'unverified' });
      const host = await show();
      if (context === 'account')
        await act(async () => {
          portStore.set(signedInPort(EMBEDDED, { userId: 'another-person' }));
        });
      else if (context === 'chain') await click(button(host, 'Switch chain'));
      else
        await act(async () => {
          portStore.set(signedInPort(EMBEDDED, { userId: USER }, 'live'));
        });
      await settle(20);
      release(snapshots());
      await settle(20);
      expect(host.querySelectorAll('[data-ui="publish-row"]')).toHaveLength(0);
      expect(router.push).not.toHaveBeenCalled();
    },
  );
  it('offers no substituted strategy for an unpublishable personal concentration', async () => {
    // A registry under the first rules: three assets at the fewest, 50% at the most.
    const calls = api({ limits: () => json(limitsOf('solana', { rules: 1 })) });
    read.mockResolvedValue(snapshots(first, [{ asset: 'solana:spyx', weightBps: 10000 }]));
    const host = await show();
    expect(host.textContent).toContain(en.shared.publish.rules.count(3, 12));
    expect(host.textContent).toContain(en.shared.publish.rules.weight('2%', '50%', '0.5%'));
    await click(button(host));
    expect(calls.filter((c) => c.path === '/v1/orders')).toHaveLength(0);
    expect(host.querySelectorAll('[data-ui="publish-row"]')).toHaveLength(1);
  });
});

describe('the rules a publish is held to are the chain’s, read from it (SHARED-RULES-V2)', () => {
  const sixty = [{ asset: 'solana:spyx', weightBps: 6000 }];

  it('under the first rules, refuses one asset and a vault that keeps cash, as the chain would', async () => {
    const calls = api({ limits: () => json(limitsOf('solana', { rules: 1 })) });
    read.mockResolvedValue(snapshots(first, sixty));
    const host = await show();
    expect(host.textContent).toContain(en.shared.publish.rules.count(3, 12));
    expect(host.textContent).toContain(en.shared.publish.rules.weight('2%', '50%', '0.5%'));
    expect(host.textContent).toContain(en.shared.publish.rules.sum);
    // What the target leaves is shown as the vault's cash, not added to the token.
    expect(find(host, '[data-ui="publish-cash"]').textContent).toContain('40%');
    await click(button(host));
    expect(calls.filter((c) => c.path === '/v1/orders')).toHaveLength(0);
  });

  it('under the second, publishes one asset with the rest in cash, and warns on its cap with the figure', async () => {
    const calls = api({
      limits: () =>
        json(
          limitsOf('solana', {
            rules: 2,
            ceilings: [{ asset: 'solana:spyx', maxWeightBps: 2500 }],
          }),
        ),
    });
    read.mockResolvedValue(snapshots(first, sixty));
    const host = await show();
    const p = en.shared.publish;
    expect(host.textContent).not.toContain(p.rules.count(1, 16));
    expect(host.textContent).not.toContain(p.rules.sumAtMost);
    expect(host.textContent).toContain(
      p.rules.shape('Solana', 1, 16, '0.5%', '100%', '0.5%', true),
    );
    expect(find(host, '[data-ui="publish-cash"]').textContent).toContain('40%');
    // A warning that cites the cap, not a refusal (ANY-COMPOSITION, EXIT-SOURCE).
    expect(find(host, '[data-ui="publish-over-cap"]').textContent).toBe(
      p.rules.overCap('SPYx', '60%', '25%'),
    );
    await click(button(host));
    await settle(10);
    expect(calls.find((c) => c.path === '/v1/orders')?.body).toMatchObject({
      recipes: [{ chain: 'solana', components: [{ kind: 'asset', ...sixty[0] }] }],
    });
  });

  it('pauses publishing while the rules are read, and when the chain does not say them', async () => {
    const calls = api({
      limits: () => json({ error: 'the chain did not answer', code: 'CHAIN_UNAVAILABLE' }, 503),
    });
    const host = await show();
    expect(host.textContent).toContain(en.shared.publish.rules.unread('Solana'));
    expect(host.querySelector('[data-ui="publish-over-cap"]')).toBeNull();
    await click(button(host));
    expect(calls.filter((c) => c.path === '/v1/orders')).toHaveLength(0);
  });
});
