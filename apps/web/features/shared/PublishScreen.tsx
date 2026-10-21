'use client';
import {
  ChainId,
  chainFamily,
  type SharedFamily,
  TAKEN_SLUGS,
  type Target,
} from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { PAGE_TITLE } from '../../components/ui/heading';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { SkeletonLine, SkeletonListRow } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatBps, tokenName } from '../order/amounts';
import { keepOrder } from '../order/order-record';
import { deploymentsFor, networkFor, onMock, publishableOn } from '../order/readiness';
import { assetsFor, unitsFor } from '../order/units';
import { tokens } from '../portfolio/figures';
import { readPortfolio, type Vault } from '../portfolio/portfolio';
import { sameAddress } from '../portfolio/vault-name';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { familyIdFor } from './chain-recipe';
import { type ChainRules, overCeiling } from './over-ceiling';
import { type PublishVaultRead, readPublishVault } from './publish-vault';
import { placeShared, readFamily, readLimits } from './shared-api';
import type { SharedTerms } from './terms';
import { useSharedPerson } from './use-person';
import { useShelfScope } from './use-shelf';
import { PublishWait } from './waits';

// Publish an owner-proved vault's strategy through the existing reviewed order/signature contract.
// The vaults offered are the person's on every chain whose portfolios Products lists, whatever chain
// their account is on (gate PUBLISH-ANY-CHAIN): the chosen vault's chain is the publish's, and the
// wallet is switched to it when it signs, as for any order. Assets and weights are immutable here. A
// fresh chain read must still match the displayed snapshot before an order is made, and any
// person/chain/network/vault change discards a late reply.
//
// What the assets and weights are held to is the chain's to say, read from its registry for this page
// (`GET /v1/shared/limits`): the first rules until a registry is upgraded, the second after (gate
// SHARED-RULES-V2), so the form follows whichever is live and never holds a number of its own.

/** The text's limits, the server's (apps/api/src/orders/shared.ts). The assets' are the chain's. */
export const LIMITS = { chars: 280 } as const;

/** The rules a chain holds a publish to, as the server read them from it. */
export type { ChainRules };

// The server's rules for the creator's text (apps/api/src/orders/shared.ts), the same here so the
// form says so before anything is sent: a link, a scheme or `www.` or a bare host (`evil.xyz/airdrop`),
// an email address included; and a character a person cannot see or that turns text around.
const LINK = /:\/\/|www\.|(?<!\w)[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![\w-])/i;
const HIDDEN = /\p{Cf}|(?!\n)\p{Cc}/u;
const ASCII = /^[\x20-\x7e]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** A weight typed in percent, as basis points; null when it is not a number with at most two places. */
export function bpsOf(text: string): number | null {
  const plain = text.trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(plain)) return null;
  return Math.round(Number(plain) * 100);
}

/** An address on the shelf made from a name: lower case, letters and digits, dashes between. */
export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

export type Problem =
  | 'chain'
  | 'name'
  | 'slug'
  | 'copy'
  | 'count'
  | 'weight'
  | 'ceiling'
  | 'sum'
  | 'twice';

/**
 * What the form breaks of the rules a portfolio follows, in the order the form reads. The text's rules
 * are the server's; the assets' are the chain's (`rules`), and are not judged before they are read.
 */
export function problemsOf(
  form: {
    name: string;
    slug: string;
    copy: string;
    rows: { asset: string; bps: number | null }[];
  },
  rules: ChainRules | null = null,
): Problem[] {
  const out: Problem[] = [];
  if (
    !ASCII.test(form.name) ||
    form.name.trim() !== form.name ||
    form.name.length > LIMITS.chars ||
    LINK.test(form.name)
  )
    out.push('name');
  if (!SLUG.test(form.slug) || form.slug.length > 64 || TAKEN_SLUGS.includes(form.slug))
    out.push('slug');
  if (form.copy.length > LIMITS.chars || LINK.test(form.copy) || HIDDEN.test(form.copy))
    out.push('copy');
  if (rules) {
    const L = rules.limits;
    if (form.rows.length < L.minAssets || form.rows.length > L.maxAssets) out.push('count');
    if (
      form.rows.some(
        (r) =>
          r.bps === null ||
          r.bps < L.minWeightBps ||
          r.bps > L.maxWeightBps ||
          r.bps % L.stepBps !== 0,
      )
    )
      out.push('weight');
    // Under the first rules an asset's ceiling on the list is a limit; under the second, a warning.
    if (L.rules === 1 && overCeiling(form.rows, rules).length > 0) out.push('ceiling');
    const sum = form.rows.reduce((n, r) => n + (r.bps ?? 0), 0);
    if (L.rules === 1 ? sum !== L.sumBps : sum > L.sumBps) out.push('sum');
  }
  if (new Set(form.rows.map((r) => r.asset)).size !== form.rows.length) out.push('twice');
  return out;
}

export { overCeiling };

type Existing =
  | { kind: 'reading' }
  | { kind: 'new' }
  | { kind: 'mine'; family: SharedFamily; next: number }
  /** The person's own portfolio, whose id is not its slug's: not updated from here (gate FAMILY-ID). */
  | { kind: 'foreign' }
  | { kind: 'theirs' }
  | { kind: 'unreadable' };

export function PublishScreen() {
  const t = useT();
  const lang = useLang();
  const p = t.shared.publish;
  const router = useRouter();
  const apiFetch = useApiFetch();
  const port = useWalletPort();
  // The vault the address names (`?vault=…&chain=…`, from the vault's page), read once mounted: on an
  // in-app move the address changes after the page first draws. Null until it is read.
  const [asked, setAsked] = useState<{ address: string; chain: ChainId | null } | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const read = ChainId.safeParse(query.get('chain'));
    setAsked({ address: query.get('vault') ?? '', chain: read.success ? read.data : null });
  }, []);
  /** Who is looking, on no chain in particular: signed in, and on which chains a wallet of theirs signs. */
  const anyone = useSharedPerson();
  const scope = useShelfScope();
  /** The vault chosen, by chain and address: its chain is the one everything below is asked about. */
  const [pick, setPick] = useState<{ chain: ChainId; address: string } | null>(null);
  const person = useSharedPerson(pick?.chain ?? null);
  const ready = pick !== null && person.kind === 'ready';
  const chain = ready ? person.chain : null;
  const mock = ready ? person.mock : false;
  const assets = chain ? assetsFor(chain, mock) : [];
  const [name, setName] = useState('');
  const [slugText, setSlugText] = useState<string | null>(null);
  const [copy, setCopy] = useState('');
  /** The person's vaults on the chains offered, and the chain of the vault the link named where it is not. */
  const [vaults, setVaults] = useState<{
    key: string;
    values: Vault[];
    unlisted: ChainId | null;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; read: PublishVaultRead } | null>(null);
  const [sourceFailure, setSourceFailure] = useState(false);
  const [existing, setExisting] = useState<Existing>({ kind: 'new' });
  /** The chain's rules, read for this person, chain and network: null while they are read. */
  const [rules, setRules] = useState<{ key: string; read: ChainRules | 'unread' } | null>(null);
  const [placing, setPlacing] = useState(false);
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  /** The parts of the form the person has put a hand to: a rule is said once its part has been. */
  const [touched, setTouched] = useState({ name: false, slug: false, copy: false, rows: false });
  const touch = (part: keyof typeof touched) =>
    setTouched((was) => (was[part] ? was : { ...was, [part]: true }));
  const reasonId = useId();
  const slug = slugText ?? slugOf(name);
  const owner = ready ? person.owner : null;
  const selected = pick?.address ?? '';

  // The chains whose vaults are offered: the person's, where Products lists what is published there
  // (gate PRODUCTS-MAINNET-ONLY: with `SHELF_LIVE_ONLY` on, the live chains alone), and where a
  // portfolio can be published (on EVM, where the deployment names its registry).
  const held = anyone.kind === 'ready' ? anyone.held : [];
  const listed = scope ? held.filter((c) => !scope.liveOnly || scope.live.includes(c)) : [];
  const offered = listed.filter((c) => publishableOn(deploymentsFor(c, onMock(port, c))?.[c]));
  const owners = offered.map((c) => [c, port.active(chainFamily(c))?.address ?? null] as const);
  const who = JSON.stringify([
    anyone.kind === 'ready' ? anyone.userId : null,
    scope?.liveOnly ?? null,
    owners,
  ]);

  // Every asynchronous result belongs to this person, chain, network and selected vault.
  const deployment = chain ? deploymentsFor(chain, mock)?.[chain] : undefined;
  const identity = JSON.stringify([
    who,
    person.kind === 'ready' ? person.userId : null,
    chain,
    owner,
    mock,
    chain ? networkFor(chain, mock) : null,
    chain ? port.network(chain) : null,
    person.kind === 'ready' ? [person.signable, person.off, person.publishable] : null,
    deployment,
  ]);
  const sourceKey = `${identity}:${selected}:${vaults?.key === who ? (vaults.values.find((v) => v.chain === chain && v.address === selected)?.basketId ?? '') : ''}`;
  const active = useRef({ key: sourceKey, revision: 0, form: '' });
  if (active.current.key !== sourceKey) {
    active.current = { key: sourceKey, revision: active.current.revision + 1, form: '' };
  }
  active.current.form = JSON.stringify([name, slug, copy, existing]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `who` holds the chains offered and their owners
  useEffect(() => {
    if (!scope || anyone.kind !== 'ready' || !asked) return;
    let current = true;
    setVaults(null);
    setPick(null);
    setSourceFailure(false);
    const ownerOn = new Map(owners);
    const named = (v: Vault) =>
      sameAddress(v.chain, v.address, asked.address) && (!asked.chain || v.chain === asked.chain);
    readPortfolio(apiFetch).then((result) => {
      if (!current) return;
      if (result.kind !== 'read') return setSourceFailure(true);
      const all = result.chains.flatMap((entry) => entry.vaults);
      const values = all.filter((v) => {
        const mine = ownerOn.get(v.chain);
        return mine != null && sameAddress(v.chain, v.owner, mine);
      });
      // The vault the link named, where Products does not list its chain: said, and not chosen.
      const namedOn = asked.address ? (asked.chain ?? all.find(named)?.chain ?? null) : null;
      const unlisted = namedOn && scope.liveOnly && !scope.live.includes(namedOn) ? namedOn : null;
      setVaults({ key: who, values, unlisted });
      // An explicit invalid source link never silently selects a different vault.
      const first = asked.address ? values.find(named) : values[0];
      setPick(first ? { chain: first.chain, address: first.address } : null);
    });
    return () => {
      current = false;
    };
  }, [apiFetch, who, asked]);
  const own = vaults?.key === who ? vaults.values : [];
  const source = chain ? own.find((v) => v.chain === chain && v.address === selected) : undefined;
  useEffect(() => {
    setSnapshot(null);
    setFailure(null);
    inFlight.current = false;
    setPlacing(false);
    if (!chain || !owner || !source) return;
    let current = true;
    const at = { chain, owner, address: source.address, basketId: source.basketId, mock };
    readPublishVault(apiFetch, at).then((read) => {
      if (current) setSnapshot({ key: sourceKey, read });
    });
    return () => {
      current = false;
    };
  }, [apiFetch, chain, owner, source, mock, sourceKey]);

  // The rules a publish on this chain is held to, as its registry says them now.
  useEffect(() => {
    if (!chain) return;
    let current = true;
    setRules(null);
    readLimits(apiFetch, chain).then((read) => {
      if (!current) return;
      setRules({
        key: identity,
        read:
          read.kind === 'read' && read.value.chain === chain
            ? {
                limits: read.value.limits,
                ceilings: read.value.ceilings,
                ceilingsFrom: read.value.ceilingsFrom,
              }
            : 'unread',
      });
    });
    return () => {
      current = false;
    };
  }, [apiFetch, chain, identity]);

  // Whether this address is a portfolio already: the person's own (the next version) or another's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: account and network changes invalidate the family read
  useEffect(() => {
    if (!chain || !SLUG.test(slug)) {
      setExisting({ kind: 'new' });
      return;
    }
    let mine = true;
    setExisting({ kind: 'reading' });
    const timer = setTimeout(async () => {
      const read = await readFamily(apiFetch, slug, chain);
      if (!mine) return;
      if (read.kind !== 'read')
        return setExisting({ kind: read.kind === 'no-plan' ? 'new' : 'unreadable' });
      const recipe = read.value.family.recipes.find((r) => r.chain === chain);
      if (!recipe || !owner || !sameAddress(chain, recipe.creator, owner))
        return setExisting({ kind: 'theirs' });
      // An update is only of a portfolio whose id is its slug's: the id the guard holds the bytes to
      // is the one this page works out, never the server's (gate FAMILY-ID).
      if (read.value.family.familyId !== familyIdFor(slug)) return setExisting({ kind: 'foreign' });
      setExisting({
        kind: 'mine',
        family: read.value.family,
        next: (recipe.pending?.version ?? recipe.active.version) + 1,
      });
    }, 300);
    return () => {
      mine = false;
      clearTimeout(timer);
    };
  }, [apiFetch, slug, chain, owner, identity]);

  if (anyone.kind === 'loading' || scope === null) return <PublishWait />;
  if (anyone.kind !== 'ready')
    return (
      <section className="flex flex-col items-start gap-4">
        <h1 className={PAGE_TITLE}>{p.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body">
          {anyone.kind === 'no-chain' ? t.goal.blocked.chainNotChosen : p.signIn}
        </p>
        <Link
          href="/sign-in?next=/products/publish"
          className={buttonClass({ variant: 'secondary' })}
        >
          {t.shell.signIn}
        </Link>
      </section>
    );
  // Every chain of theirs that Products lists takes no publish yet.
  if (listed.length > 0 && offered.length === 0)
    return (
      <section className="flex flex-col items-start gap-4">
        <h1 className={PAGE_TITLE}>{p.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body">{p.problems.chain}</p>
      </section>
    );
  const chainList = (chains: readonly ChainId[]) =>
    new Intl.ListFormat(LOCALE[lang], { type: 'disjunction' }).format(
      chains.map((c) => t.chain.names[c]),
    );
  const liveChains = scope.liveOnly ? chainList(scope.live) : '';
  const listing = vaults?.key === who ? vaults : null;
  // Said only of the vault the link named: why its chain's vaults are not offered here.
  const unlisted = listing?.unlisted ? (
    <p data-ui="publish-unlisted" className="max-w-(--tf-measure-body) text-body">
      {p.notListed(
        t.chain.names[listing.unlisted],
        networkFor(listing.unlisted, false) === 'testnet',
      )}
    </p>
  ) : null;
  if (listing && listing.values.length === 0)
    return (
      <section data-ui="publish-no-vault" className="flex flex-col items-start gap-4">
        <h1 className={PAGE_TITLE}>{p.title}</h1>
        {unlisted}
        <p className="max-w-(--tf-measure-body) text-body">
          {p.noVaultOn(liveChains)}{' '}
          <Link href="/invest" className={buttonClass({ variant: 'link' })}>
            {p.makeVault}
          </Link>
        </p>
      </section>
    );

  const sourceRead = snapshot?.key === sourceKey ? snapshot.read : null;
  const components = sourceRead?.kind === 'read' ? sourceRead.components : [];
  const read = components.map((r) => ({ asset: r.asset, bps: r.weightBps }));
  const chainRules = rules?.key === identity && rules.read !== 'unread' ? rules.read : null;
  const problems = problemsOf({ name, slug, copy, rows: read }, chainRules);
  const sum = read.reduce((n, r) => n + (r.bps ?? 0), 0);
  // Under the second rules a weight over its asset's ceiling is published, and said with the ceiling.
  const overCaps = chainRules?.limits.rules === 2 ? overCeiling(read, chainRules) : [];
  // Always the page's own: an update is offered only where the stored id is this one.
  const familyId = familyIdFor(slug || 'x');
  const chainName = chain ? t.chain.names[chain] : '';
  const locale = LOCALE[lang];
  // The cash token is not among the assets a portfolio may hold, so its symbol is the chain's units':
  // "USDG", never "robinhood:usdg" (Thom, Oct 15).
  const units = chain ? unitsFor(chain, mock) : null;
  const symbolOf = (id: string) =>
    assets.find((a) => a.id === id)?.symbol ?? units?.tokens[id]?.symbol ?? tokenName(id);
  // A rule the form breaks is said after the person has typed in its part, or asked for the review:
  // an empty form says nothing is wrong with it yet.
  const partOf = (k: Problem): keyof typeof touched =>
    k === 'name' || k === 'slug' || k === 'copy' ? k : 'rows';
  const said = problems.filter(
    (k) =>
      tried ||
      (sourceRead?.kind === 'read' && partOf(k) === 'rows') ||
      k === 'chain' ||
      touched[partOf(k)] ||
      (k === 'slug' && touched.name),
  );
  const pct = (bps: number) => formatBps(bps, LOCALE[lang]);
  const ruleText = (k: Problem): string => {
    const L = chainRules?.limits;
    if (k === 'count') return p.rules.count(L?.minAssets ?? 0, L?.maxAssets ?? 0);
    if (k === 'weight')
      return p.rules.weight(
        pct(L?.minWeightBps ?? 0),
        pct(L?.maxWeightBps ?? 0),
        pct(L?.stepBps ?? 0),
      );
    if (k === 'sum') return L?.rules === 1 ? p.rules.sum : p.rules.sumAtMost;
    if (k === 'ceiling')
      return chainRules
        ? overCeiling(read, chainRules)
            .map((o) => p.rules.ceiling(symbolOf(o.asset), pct(o.bps), pct(o.ceilingBps)))
            .join(' ')
        : '';
    return p.problems[k as 'name' | 'slug' | 'copy' | 'twice' | 'chain'];
  };
  const blocked = [
    ...(chain && rules?.key === identity && rules.read === 'unread'
      ? [p.rules.unread(chainName)]
      : []),
    ...(chain && rules?.key !== identity ? [p.rules.reading(chainName)] : []),
    ...said.map(ruleText),
    ...(sourceFailure ? [p.sourceUnavailable] : []),
    ...(!source && !sourceFailure ? [listing ? p.noVaults : p.readingVaults] : []),
    ...(source && !sourceRead ? [p.readingStrategy] : []),
    ...(sourceRead && sourceRead.kind !== 'read' ? [p.sourceProblems[sourceRead.kind]] : []),
    ...(existing.kind === 'theirs' ? [p.theirs] : []),
    ...(existing.kind === 'foreign' ? [t.shared.family.foreign] : []),
    ...(existing.kind === 'reading' ? [t.shared.check.reading] : []),
    ...(existing.kind === 'unreadable' ? [p.failure.unreadable] : []),
    ...(ready && (!person.signable || person.off)
      ? [t.shared.family.chainNotReady(chainName)]
      : []),
    ...(ready && !person.publishable ? [p.problems.chain] : []),
    ...(chain && !owner ? [t.buy.blocked.wallet] : []),
  ];

  async function review() {
    setTried(true);
    if (
      inFlight.current ||
      placing ||
      problems.length > 0 ||
      blocked.length > 0 ||
      !source ||
      sourceRead?.kind !== 'read' ||
      !chain ||
      !owner ||
      person.kind !== 'ready' ||
      !person.userId
    )
      return;
    inFlight.current = true;
    setPlacing(true);
    setFailure(null);
    const guard = { ...active.current };
    const current = () =>
      alive.current &&
      active.current.key === guard.key &&
      active.current.revision === guard.revision &&
      active.current.form === guard.form;
    const fresh = await readPublishVault(apiFetch, {
      chain,
      owner,
      address: source.address,
      basketId: source.basketId,
      mock,
    });
    if (!current()) return;
    if (fresh.kind !== 'read') {
      setSnapshot({ key: sourceKey, read: fresh });
      inFlight.current = false;
      setPlacing(false);
      return;
    }
    if (
      JSON.stringify([
        fresh.strategy,
        fresh.components,
        fresh.source,
        fresh.value.provenance,
        fresh.value.vault.recipeOnchainId,
        fresh.value.vault.acceptedVersion,
      ]) !==
      JSON.stringify([
        sourceRead.strategy,
        components,
        sourceRead.source,
        sourceRead.value.provenance,
        sourceRead.value.vault.recipeOnchainId,
        sourceRead.value.vault.acceptedVersion,
      ])
    ) {
      setSnapshot({ key: sourceKey, read: fresh });
      setFailure(p.strategyChanged);
      inFlight.current = false;
      setPlacing(false);
      return;
    }
    const familyRead = await readFamily(apiFetch, slug, chain);
    if (!current()) return;
    if (familyRead.kind !== 'read' && familyRead.kind !== 'no-plan') {
      setFailure(p.failure.unreadable);
      inFlight.current = false;
      setPlacing(false);
      return;
    }
    let now: Existing = { kind: 'new' };
    if (familyRead.kind === 'read') {
      const recipe = familyRead.value.family.recipes.find((r) => r.chain === chain);
      now =
        !recipe || !sameAddress(chain, recipe.creator, owner)
          ? { kind: 'theirs' }
          : familyRead.value.family.familyId !== familyId
            ? { kind: 'foreign' }
            : {
                kind: 'mine',
                family: familyRead.value.family,
                next: (recipe.pending?.version ?? recipe.active.version) + 1,
              };
    }
    if (
      now.kind !== existing.kind ||
      (now.kind === 'mine' && existing.kind === 'mine' && now.next !== existing.next)
    ) {
      setExisting(now);
      setFailure(t.shared.refusal.versionChanged);
      inFlight.current = false;
      setPlacing(false);
      return;
    }
    // Freeze the exact display; no private chat text enters these public terms.
    const frozen: Target[] = fresh.components.map((c) => ({ ...c }));
    // What the guard holds the bytes to: this form's id, text and weights.
    const terms: SharedTerms = {
      kind: 'publish',
      action: existing.kind === 'mine' ? 'update' : 'publish',
      familyId,
      components: frozen,
      text: { slug, name, copy, kind: 'index' },
      version: existing.kind === 'mine' ? existing.next : 1,
    };
    const placed = await placeShared(
      apiFetch,
      {
        type: 'publish',
        creator: { [chainFamily(chain)]: owner },
        family: slug,
        familyId,
        name,
        copy,
        recipes: [{ chain, components: frozen.map((c) => ({ kind: 'asset', ...c })) }],
        // The order's warnings (a weight over its listed ceiling) come back in the page's language.
        language: lang,
      },
      { chain, owner, type: 'publish' },
    );
    if (!current()) return;
    if (placed.kind !== 'placed') {
      inFlight.current = false;
      setPlacing(false);
      setFailure(
        placed.kind === 'said'
          ? p.failure.said(placed.error)
          : placed.kind === 'busy'
            ? t.shell.slowDown
            : placed.kind === 'signed-out'
              ? p.failure.signedOut
              : placed.kind === 'unreadable'
                ? p.failure.unreadable
                : p.failure.unreachable,
      );
      return;
    }
    const kept = keepOrder({
      orderId: placed.order.id,
      userId: person.userId,
      proposalId: '',
      chain,
      amountUsd: 0,
      lines: [],
      terms,
      approved: null,
    });
    if (!kept) {
      inFlight.current = false;
      setPlacing(false);
      setFailure(p.failure.noStore);
      return;
    }
    router.push(`/portfolio/orders/${encodeURIComponent(placed.order.id)}`);
  }

  return (
    <div data-ui="publish-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className={PAGE_TITLE}>{p.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body-lg">{p.lead}</p>
      </header>

      <form
        className="grid items-start gap-6 lg:grid-cols-2 [&>*]:min-w-0"
        onSubmit={(e) => {
          e.preventDefault();
          review();
        }}
        noValidate
      >
        <Card as="section" aria-label={p.sourceVault} className="lg:col-span-2">
          <CardBody className="flex flex-col gap-4">
            {unlisted}
            <Field label={p.sourceVault} hint={p.sourceHint(liveChains)}>
              {(control) => (
                <Select
                  {...control}
                  value={pick ? `${pick.chain}:${pick.address}` : ''}
                  onChange={(e) => {
                    const v = own.find((o) => `${o.chain}:${o.address}` === e.currentTarget.value);
                    setPick(v ? { chain: v.chain, address: v.address } : null);
                  }}
                >
                  <option value="">{p.chooseVault}</option>
                  {own.map((v) => (
                    <option key={`${v.chain}:${v.address}`} value={`${v.chain}:${v.address}`}>
                      {t.chain.names[v.chain]} · {v.name ?? v.address}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {source && (
              <Link
                href={`/portfolio/vaults/${chain}/${encodeURIComponent(source.address)}`}
                className={buttonClass({ variant: 'link' })}
              >
                {p.editStrategy}
              </Link>
            )}
            {source && (
              <p
                data-ui="publish-source"
                className="break-all font-mono text-source text-muted-foreground"
              >
                {chainName} · {source.address}
              </p>
            )}
            {/* While the vaults are read the two lines a chosen vault brings keep their place: the
                way back to its conversation and its address. A read that failed ends the wait: the
                sentence under the button says so. */}
            {!source && !listing && !sourceFailure && (
              <span
                aria-hidden="true"
                data-ui="publish-source-wait"
                className="flex flex-col gap-4"
              >
                <SkeletonLine className="text-body" width="w-56" />
                {/* an address breaks over two lines on a phone */}
                <SkeletonLine className="font-mono text-source sm:hidden" lines={2} />
                <SkeletonLine className="font-mono text-source max-sm:hidden" width="w-96" />
              </span>
            )}
            <p className="max-w-(--tf-measure-body) text-body-sm">{p.privacy}</p>
          </CardBody>
        </Card>

        {/* The form holds no figure, so it carries no sample tag (the UI audit, G9). */}
        <Card as="section" aria-label={p.about}>
          <CardBody className="flex flex-col gap-5">
            <Field
              label={p.name}
              hint={p.nameHint}
              error={tried && problems.includes('name') ? p.problems.name : undefined}
            >
              {(control) => (
                <Input
                  {...control}
                  disabled={placing}
                  value={name}
                  maxLength={LIMITS.chars}
                  autoComplete="off"
                  onChange={(e) => {
                    touch('name');
                    setName(e.currentTarget.value);
                  }}
                />
              )}
            </Field>
            <Field
              label={p.slug}
              hint={p.slugHint}
              error={
                tried && problems.includes('slug')
                  ? p.problems.slug
                  : existing.kind === 'theirs'
                    ? p.theirs
                    : undefined
              }
            >
              {(control) => (
                <Input
                  {...control}
                  disabled={placing}
                  value={slug}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    touch('slug');
                    setSlugText(e.currentTarget.value);
                  }}
                />
              )}
            </Field>
            <Field
              label={p.copy}
              hint={p.copyHint}
              error={tried && problems.includes('copy') ? p.problems.copy : undefined}
            >
              {(control) => (
                <Textarea
                  {...control}
                  disabled={placing}
                  value={copy}
                  maxLength={LIMITS.chars}
                  onChange={(e) => {
                    touch('copy');
                    setCopy(e.currentTarget.value);
                  }}
                />
              )}
            </Field>
            <div className="flex flex-col gap-1">
              <p className="text-caption font-medium">{p.familyId}</p>
              <p
                data-ui="family-id"
                className="break-all font-mono text-source text-muted-foreground"
              >
                {SLUG.test(slug) ? familyId : '—'}
              </p>
            </div>
            <p className="max-w-(--tf-measure-body) text-body-sm">
              {existing.kind === 'mine' ? p.update(existing.next) : p.first}
            </p>
          </CardBody>
        </Card>

        <Card
          as="section"
          aria-label={p.assets}
          mock={
            sourceRead?.kind === 'read' &&
            (sourceRead.source === 'mock' ||
              !chain ||
              networkFor(chain, mock) !== 'mainnet' ||
              sourceRead.value.provenance !== 'live')
          }
          mockLabels={{
            announce:
              sourceRead?.kind === 'read' && sourceRead.source === 'mock'
                ? t.shell.mockAnnounce
                : t.shell.testNetworkLine,
          }}
        >
          <CardHeader title={p.assets} level={2} meta={p.total(formatBps(sum, locale))} />
          <CardBody className="flex flex-col gap-4">
            <p className="text-body-sm text-muted-foreground">
              {p.assetsHint}
              {chainRules &&
                ` ${p.rules.shape(
                  chainName,
                  chainRules.limits.minAssets,
                  chainRules.limits.maxAssets,
                  pct(chainRules.limits.minWeightBps),
                  pct(chainRules.limits.maxWeightBps),
                  pct(chainRules.limits.stepBps),
                  chainRules.limits.rules === 2,
                )}`}
            </p>
            <ul className="flex flex-col gap-3">
              {components.map((row) => (
                <li
                  key={row.asset}
                  data-ui="publish-row"
                  className="flex justify-between gap-3 text-body"
                >
                  <span>{symbolOf(row.asset)}</span>
                  <span className="tabular-nums">{formatBps(row.weightBps, locale)}</span>
                </li>
              ))}
              {/* What the targets leave is the vault's cash, published as it is where the chain's
                  rules let it: shown as a line of its own, never as a token's target. */}
              {sourceRead?.kind === 'read' && sum < 10_000 && (
                <li data-ui="publish-cash" className="flex justify-between gap-3 text-body">
                  <span>{p.rules.cash}</span>
                  <span className="tabular-nums">{formatBps(10_000 - sum, locale)}</span>
                </li>
              )}
            </ul>
            {overCaps.length > 0 && (
              <ul data-ui="publish-over-cap" className="flex flex-col gap-1 text-body-sm">
                {overCaps.map((o) => (
                  <li key={o.asset} className="flex items-start gap-1.5">
                    <StatusMark status="watch" size={12} className="mt-1.5" />
                    <span>
                      {p.rules.overCap(symbolOf(o.asset), pct(o.bps), pct(o.ceilingBps))}{' '}
                      {chainRules && (
                        <ProvenancePin
                          value={pct(o.ceilingBps)}
                          obs={chainRules.ceilingsFrom}
                          what={p.rules.capOnList}
                          labels={t.pin}
                        />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {/* The strategy's rows while the vaults, then the chosen vault's strategy, are read. The
                sentence under the form's button says which; no share is drawn before it is read. */}
            {((!vaults && !sourceFailure) || (source && !sourceRead)) && (
              <span aria-hidden="true" data-ui="publish-rows-wait" className="flex flex-col gap-3">
                {[0, 1, 2].map((i) => (
                  <SkeletonListRow key={i} mark={false} type="text-body" />
                ))}
              </span>
            )}
            {sourceRead?.kind === 'read' && (
              <>
                <h2 className="text-caption font-medium">{p.holdings}</h2>
                <ul className="flex flex-col gap-2 text-body-sm">
                  {[sourceRead.value.vault.cash, ...sourceRead.value.vault.positions].map(
                    (holding) => (
                      <li key={holding.asset} className="flex justify-between gap-3">
                        <span>{symbolOf(holding.asset)}</span>
                        <span className="tabular-nums">{tokens(lang, holding.display)}</span>
                      </li>
                    ),
                  )}
                </ul>
              </>
            )}
          </CardBody>
        </Card>

        <div className="flex flex-col items-start gap-2 lg:col-span-2">
          <Button
            type="submit"
            variant="primary"
            busy={placing}
            busyLabel={p.reviewing}
            disabled={blocked.length > 0 || !source || sourceRead?.kind !== 'read'}
            aria-describedby={blocked.length > 0 ? reasonId : undefined}
          >
            {p.review}
          </Button>
          {blocked.length > 0 && (
            <ul
              id={reasonId}
              className="flex max-w-(--tf-measure-body) flex-col gap-1 text-body-sm"
            >
              {blocked.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {failure && (
            <p
              role="alert"
              className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
            >
              <StatusMark status="off-track" size={12} className="mt-1.5" />
              <span className="[overflow-wrap:anywhere]">{failure}</span>
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
