// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { withAccount } from '../account/test/screen';
import { emptyRead, read } from '../vault-conversation/test/fixtures';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { VaultHoldings } from './VaultHoldings';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The holdings panel of a vault's page, folded to its own head while a draft has the pane (Thom, Oct
// 14): its title and figures stay, the press beside them opens the rest, and nothing is drawn as a box
// in a box.

const v = dictionary('en').shared.vault;
beforeEach(() => {
  portStore.set(signedInPort(EMBEDDED, { userId: 'did:privy:holdings' }));
  portStore.setApi(async () => json({}, 404));
});
afterEach(unmountAll);

describe('the holdings panel while a draft has the pane', () => {
  for (const [name, fixture] of [
    ['a vault that holds tokens', read],
    ['an empty vault', emptyRead],
  ] as const)
    it(`folds to its own head, a press away, for ${name}`, async () => {
      const host = await mount(
        withAccount('en', createElement(VaultHoldings, { read: fixture, folded: true })),
      );
      const panel = find(host, '[data-ui="vault-holdings-panel"]');
      expect(panel.dataset.folded).toBe('true');
      // one panel: no panel or card inside it
      expect(panel.querySelector('[data-ui="vault-holdings-panel"], [data-ui="card"]')).toBeNull();
      const toggle = find(panel, '[data-action="fold-toggle"]');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-label')).toBe(`${v.page.show} ${v.page.holdings}`);
      const body = find(host, `#${CSS.escape(toggle.getAttribute('aria-controls') ?? '')}`);
      expect(panel.contains(body)).toBe(true);
      expect(body.hidden).toBe(true);
      await click(toggle);
      expect(body.hidden).toBe(false);
      expect(panel.dataset.folded).toBeUndefined();
      expect(toggle.getAttribute('aria-label')).toBe(`${v.page.hide} ${v.page.holdings}`);
    });

  it('is open, with no press, when no draft has the pane', async () => {
    const host = await mount(withAccount('en', createElement(VaultHoldings, { read })));
    expect(host.querySelector('[data-action="fold-toggle"]')).toBeNull();
    expect(find(host, '[data-ui="vault-holdings-panel"]').dataset.folded).toBeUndefined();
  });
});
