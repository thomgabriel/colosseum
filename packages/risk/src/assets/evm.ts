import type { UniverseAuthority, UniverseExtensions } from '@colosseum/schemas';

// What an EVM token is, from what the chain answered about it (PLAN-ASSETS AS.3): its symbol, name and
// decimals, its standard, whether its code sits behind an upgradeable proxy, whether that code can pause
// transfers or stop an address, and who owns or administers it. Pure: the chain's command makes the
// calls and hands the answers here. No I/O, no clock, no SDK; tests/risk-assets-robinhood.test.ts reads
// each decoder on bytes the chain gave.

/** The storage slots of EIP-1967: the keccak-256 of the name beside each, less one. */
export const EIP1967 = {
  /** eip1967.proxy.implementation */
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  /** eip1967.proxy.admin */
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  /** eip1967.proxy.beacon */
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
} as const;

/** The calls every token is asked, in this order, each [signature, selector]. */
export const TOKEN_CALLS = [
  ['decimals()', '313ce567'],
  ['symbol()', '95d89b41'],
  ['name()', '06fdde03'],
  ['asset()', '38d52e0f'],
  ['convertToAssets(uint256)', '07a2d13a'],
  ['owner()', '8da5cb5b'],
  ['defaultAdmin()', '84ef8ffc'],
] as const;
/** The amount convertToAssets is asked about: one whole share at 18 decimals. Only whether it answers is read. */
export const CONVERT_AMOUNT = 10n ** 18n;
/** Asked of a beacon: the implementation every proxy of it runs, and who may change it. */
export const BEACON_CALLS = [
  ['implementation()', '5c60da1b'],
  ['owner()', '8da5cb5b'],
] as const;

/**
 * The functions whose selector in a token's runtime code makes it pausable, or able to stop an address
 * (a blacklist, a freeze, a block list), each [signature, selector]. A selector in the code is the
 * function's dispatch, read without the source. Its absence says only that none of these names is
 * there: a list kept under another name, or in another contract, is not seen.
 */
export const CODE_SELECTORS = {
  pausable: [
    ['paused()', '5c975abb'],
    ['pause()', '8456cb59'],
    ['unpause()', '3f4ba83a'],
  ],
  blacklist: [
    ['isBlacklisted(address)', 'fe575a87'],
    ['blacklist(address)', 'f9f92be4'],
    ['isBlackListed(address)', 'e47d6060'],
    ['addBlackList(address)', '0ecb93c0'],
    ['getBlackListStatus(address)', '59bf1abe'],
    ['addToBlacklist(address)', '44337ea1'],
    ['blacklisted(address)', 'dbac26e9'],
    ['isFrozen(address)', 'e5839836'],
    ['freeze(address)', '8d1fdf2f'],
    ['freeze(address[])', '1d38fcda'],
    ['frozen(address)', 'd0516650'],
    ['isBlocked(address)', 'fbac3951'],
    ['blockAccount(address)', '7c0a893d'],
    ['isBlocklisted(address)', '8e204c43'],
    ['isDenied(address)', 'e838dfbb'],
    ['isDenylisted(address)', 'e877a526'],
    ['isBanned(address)', '97f735d5'],
    ['isSanctioned(address)', 'df592f7d'],
  ],
} as const;

/** The functions by which an implementation upgrades its own proxy (UUPS): the admin slot is then empty by design. */
export const UPGRADE_SELECTORS = [
  ['upgradeTo(address)', '3659cfe6'],
  ['upgradeToAndCall(address,bytes)', '4f1ef286'],
  ['proxiableUUID()', '52d1902d'],
] as const;

/**
 * A facet router's table: code that pushes it sends each selector to the facet `getFacet` names, by
 * DELEGATECALL. Asking `getFacet(<selector>)` of the token is a read of where a function runs.
 */
export const ROUTER_SELECTOR = ['getFacet(bytes4)', '112b6a67'] as const;

/** Every selector looked for in code, sorted: what a frozen code scan was reduced to. */
export const WATCHED_SELECTORS: readonly string[] = [
  ...new Set(
    [
      ...CODE_SELECTORS.pausable,
      ...CODE_SELECTORS.blacklist,
      ...UPGRADE_SELECTORS,
      ROUTER_SELECTOR,
    ].map(([, s]) => s),
  ),
].sort();

/** The selectors a facet router is asked about, one getFacet call each: those of CODE_SELECTORS. */
export const FACET_QUERIES: readonly string[] = [
  ...CODE_SELECTORS.pausable,
  ...CODE_SELECTORS.blacklist,
].map(([, s]) => s);

/** The calldata of getFacet(selector). */
export const getFacetCall = (selector: string) =>
  `0x${ROUTER_SELECTOR[1]}${selector.padEnd(64, '0')}`;

/** One answer of a Multicall3 call. */
export type CallReply = { success: boolean; data: string };

const strip = (hex: string) => (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
const isHex = (h: string) => /^[0-9a-f]*$/.test(h);
const ZERO = `0x${'0'.repeat(40)}`;

/** A 32-byte word as an unsigned integer; null when the answer is not exactly one word. */
export function wordUint(hex: string): bigint | null {
  const h = strip(hex);
  return h.length === 64 && isHex(h) ? BigInt(`0x${h}`) : null;
}

/** A 32-byte word holding an address (its top 12 bytes zero), lower case; null when it is not that. */
export function wordAddress(hex: string): string | null {
  const h = strip(hex);
  if (h.length !== 64 || !isHex(h) || !h.startsWith('0'.repeat(24))) return null;
  return `0x${h.slice(24)}`;
}

/** A storage word read from a proxy slot: empty, an address, or something else. */
export type SlotValue =
  | { kind: 'zero' }
  | { kind: 'address'; address: string }
  | { kind: 'not_an_address' };
export function slotValue(word: string): SlotValue {
  const h = strip(word).padStart(64, '0');
  if (h.length !== 64 || !isHex(h)) return { kind: 'not_an_address' };
  if (/^0+$/.test(h)) return { kind: 'zero' };
  const address = wordAddress(h);
  return address ? { kind: 'address', address } : { kind: 'not_an_address' };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The text of a string() answer (symbol(), name(), description()): ABI-encoded, or on older tokens one
 * bytes32 word padded with zeros. Null when it is neither, not UTF-8, empty, or holds a control
 * character: a token's text is shown and compared, never trusted.
 */
export function decodeAbiText(hex: string): string | null {
  const h = strip(hex);
  if (h.length === 0 || h.length % 64 !== 0 || !isHex(h)) return null;
  let body: string;
  if (h.length === 64) body = h.replace(/(00)+$/, '');
  else {
    if (BigInt(`0x${h.slice(0, 64)}`) !== 32n) return null;
    const len = BigInt(`0x${h.slice(64, 128)}`);
    if (len > BigInt((h.length - 128) / 2)) return null;
    body = h.slice(128, 128 + Number(len) * 2);
  }
  let text: string;
  try {
    text = UTF8.decode(Buffer.from(body, 'hex'));
  } catch {
    return null;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  return text.length > 0 && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

/** What the runtime code of one address holds, reduced to what the list reads. */
export type CodeScan = {
  /** Bytes of runtime code; 0 for an address with none. */
  size: number;
  /** A DELEGATECALL opcode outside push data and the compiler's metadata. */
  delegatecall: boolean;
  /** The address an EIP-1167 clone forwards every call to; null for any other code. */
  minimalProxyTarget: string | null;
  /** The watched selectors (WATCHED_SELECTORS) the code pushes, sorted. */
  selectors: string[];
};

/** The length of the CBOR metadata Solidity appends, its two length bytes included; 0 when there is none. */
function metadataLength(code: Uint8Array): number {
  if (code.length < 2) return 0;
  const len = ((code[code.length - 2] as number) << 8) | (code[code.length - 1] as number);
  const start = code.length - 2 - len;
  if (len === 0 || start < 0) return 0;
  const first = code[start] as number;
  // a CBOR map of one to five entries ("ipfs", "bzzr0", "bzzr1", "experimental", "solc")
  return first >= 0xa1 && first <= 0xa5 ? len + 2 : 0;
}

const CLONE = /^(?:3d|36|37|5f)*?73([0-9a-f]{40})5af4/;

/**
 * Walks the runtime code opcode by opcode, skipping push data and the trailing metadata: every PUSH4
 * immediate is a candidate selector, and a DELEGATECALL (0xf4) is noted. A code of at most 64 bytes that
 * pushes one address and delegates to it at once is an EIP-1167 clone (the 45-byte form of the EIP and
 * the 44-byte form launch pads deploy).
 */
export function scanCode(hex: string): CodeScan {
  const h = strip(hex);
  if (!isHex(h) || h.length % 2 !== 0) throw new Error('code is not hex bytes');
  const code = Buffer.from(h, 'hex');
  const end = code.length - metadataLength(code);
  const watched = new Set(WATCHED_SELECTORS);
  const found = new Set<string>();
  let delegatecall = false;
  for (let i = 0; i < end; i++) {
    const op = code[i] as number;
    if (op === 0xf4) delegatecall = true;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 4) {
        const s = code.subarray(i + 1, i + 5).toString('hex');
        if (watched.has(s)) found.add(s);
      }
      i += n;
    }
  }
  const clone = code.length <= 64 ? CLONE.exec(h) : null;
  return {
    size: code.length,
    delegatecall,
    minimalProxyTarget: clone ? `0x${clone[1]}` : null,
    selectors: [...found].sort(),
  };
}

type Flag = { value: boolean | null; reason: string | null; read: string };

/** The ERC-4626 test: asset() names a token and convertToAssets(1e18) answers one word. */
export function evmStandard(asset: CallReply, convert: CallReply): 'erc20' | 'erc4626' {
  const underlying = asset.success ? wordAddress(asset.data) : null;
  return underlying !== null &&
    underlying !== ZERO &&
    convert.success &&
    wordUint(convert.data) !== null
    ? 'erc4626'
    : 'erc20';
}

export type CodeContext = {
  /** The three EIP-1967 slots of the token, as eth_getStorageAt answered them. */
  slots: { implementation: string; admin: string; beacon: string };
  /** The scan of the token's own code. */
  own: CodeScan;
  /** The scan of another address's code, where it was read. */
  codeAt: (address: string) => CodeScan | null;
  /** implementation() and owner() of the token's beacon, where its beacon slot names one. */
  beacon: { implementation: CallReply; owner: CallReply } | null;
  /** The EIP-1967 slots of a clone's target, where the token is a clone. Its own storage, not the clone's. */
  cloneTargetSlots?: { implementation: string; admin: string; beacon: string } | null;
  /** getFacet(selector) asked of the token, by selector, where the code that runs is a facet router. */
  facets?: Record<string, CallReply> | null;
};

const sigs = (selectors: readonly (readonly [string, string])[], found: Set<string>) =>
  selectors.filter(([, s]) => found.has(s)).map(([sig]) => sig);
const slotText = (s: { implementation: string; admin: string; beacon: string }) => {
  const parts = (['implementation', 'admin', 'beacon'] as const).map((k) => {
    const v = slotValue(s[k]);
    return `${k} ${v.kind === 'address' ? v.address : v.kind === 'zero' ? 'zero' : 'not an address'}`;
  });
  return parts.join(', ');
};

/** Where the code of a token runs, as its slots and its code say. */
export type CodeLayout = {
  proxy: Flag;
  implementation: string | null;
  /** The code that runs when the token is called, each with a label; the proxy's own code first where there is one. */
  codes: Array<{ at: string; scan: CodeScan | null; shell: boolean }>;
};

/** Whether the token is an upgradeable proxy and to what, and which code runs when it is called. */
export function codeLayout(ctx: CodeContext): CodeLayout {
  const impl = slotValue(ctx.slots.implementation);
  const beacon = slotValue(ctx.slots.beacon);
  const own = { at: 'the token', scan: ctx.own, shell: false };
  if (impl.kind === 'address')
    return {
      proxy: {
        value: true,
        reason: null,
        read: `EIP-1967 implementation slot holds ${impl.address}`,
      },
      implementation: impl.address,
      codes: [
        { at: 'the proxy', scan: ctx.own, shell: true },
        { at: `the implementation ${impl.address}`, scan: ctx.codeAt(impl.address), shell: false },
      ],
    };
  if (beacon.kind === 'address') {
    const answered = ctx.beacon?.implementation.success
      ? wordAddress(ctx.beacon.implementation.data)
      : null;
    if (answered && answered !== ZERO)
      return {
        proxy: {
          value: true,
          reason: null,
          read: `EIP-1967 beacon slot holds ${beacon.address}, whose implementation() is ${answered}`,
        },
        implementation: answered,
        codes: [
          { at: 'the proxy', scan: ctx.own, shell: true },
          { at: `the implementation ${answered}`, scan: ctx.codeAt(answered), shell: false },
        ],
      };
    return {
      proxy: {
        value: null,
        reason: 'beacon_gave_no_implementation',
        read: `EIP-1967 beacon slot holds ${beacon.address}; its implementation() gave no address`,
      },
      implementation: null,
      codes: [{ at: 'the proxy', scan: ctx.own, shell: true }],
    };
  }
  if (impl.kind === 'not_an_address' || beacon.kind === 'not_an_address')
    return {
      proxy: {
        value: null,
        reason: 'slot_holds_no_address',
        read: 'an EIP-1967 implementation or beacon slot holds a word that is not an address',
      },
      implementation: null,
      codes: [own],
    };
  const target = ctx.own.minimalProxyTarget;
  if (target) {
    const scan = ctx.codeAt(target);
    const theirs = ctx.cloneTargetSlots
      ? `; the target's own slots: ${slotText(ctx.cloneTargetSlots)}`
      : "; the target's slots were not read";
    const codes = [{ at: `the clone's target ${target}`, scan, shell: false }];
    if (scan === null)
      return {
        proxy: {
          value: null,
          reason: 'clone_target_not_read',
          read: `EIP-1967 slots are zero; the code is an EIP-1167 clone of ${target}, whose code was not read`,
        },
        implementation: null,
        codes,
      };
    if (scan.delegatecall)
      return {
        proxy: {
          value: null,
          reason: 'clone_target_delegates',
          read: `EIP-1967 slots are zero; the code is an EIP-1167 clone of ${target}, whose code has a DELEGATECALL: where it forwards was not read${theirs}`,
        },
        implementation: null,
        codes,
      };
    return {
      proxy: {
        value: false,
        reason: null,
        read: `EIP-1967 slots are zero; the code is an EIP-1167 clone of ${target}, which has no DELEGATECALL, so it cannot be upgraded${theirs}`,
      },
      implementation: null,
      codes,
    };
  }
  if (ctx.own.delegatecall)
    return {
      proxy: {
        value: null,
        reason: 'delegatecall_without_eip1967_slot',
        read: 'EIP-1967 slots are zero and the code has a DELEGATECALL: where it forwards was not read',
      },
      implementation: null,
      codes: [own],
    };
  return {
    proxy: {
      value: false,
      reason: null,
      read: 'EIP-1967 implementation, admin and beacon slots are zero and the code has no DELEGATECALL',
    },
    implementation: null,
    codes: [own],
  };
}

/** True when the code that runs (not a proxy's own shell) pushes getFacet(bytes4). */
export const isFacetRouter = (layout: CodeLayout) =>
  layout.codes.some((c) => !c.shell && (c.scan?.selectors ?? []).includes(ROUTER_SELECTOR[1]));

/**
 * Whether the token is an upgradeable proxy and to what, where its code is, and what that code can do.
 * A flag is true where a selector of CODE_SELECTORS is pushed by the code that runs, or a facet router
 * names a facet for it; null where it is not found and the code that runs has a DELEGATECALL (it may
 * run code that has it), or where a code was not read; false only where none of that holds.
 */
export function evmExtensions(ctx: CodeContext): UniverseExtensions & { family: 'evm' } {
  const { proxy, implementation, codes } = codeLayout(ctx);
  const router = isFacetRouter({ proxy, implementation, codes });
  const flag = (which: keyof typeof CODE_SELECTORS): Flag => {
    const list = CODE_SELECTORS[which];
    const missing = codes.find((c) => c.scan === null);
    if (missing)
      return {
        value: null,
        reason: 'code_not_read',
        read: `the code of ${missing.at} was not read`,
      };
    const empty = codes.find((c) => c.scan?.size === 0);
    if (empty)
      return {
        value: null,
        reason: 'no_code_at_the_implementation',
        read: `${empty.at} has no code`,
      };
    const where = codes.map((c) => c.at).join(' and ');
    const found = sigs(list, new Set(codes.flatMap((c) => c.scan?.selectors ?? [])));
    if (found.length > 0)
      return { value: true, reason: null, read: `${found.join(', ')} in the code of ${where}` };
    if (router && ctx.facets) {
      // a selector the router sends to a facet whose own code pushes it
      const routed = list.flatMap(([sig, sel]) => {
        const r = ctx.facets?.[sel];
        const facet = r?.success ? wordAddress(r.data) : null;
        if (!facet || facet === ZERO) return [];
        return ctx.codeAt(facet)?.selectors.includes(sel) ? [`${sig} to ${facet}`] : [];
      });
      if (routed.length > 0)
        return {
          value: true,
          reason: null,
          read: `the code of ${where} is a facet router: getFacet() of the token sends ${routed.join(', ')}, whose code pushes it`,
        };
    }
    const delegates = codes.find((c) => !c.shell && c.scan?.delegatecall);
    if (delegates || proxy.value === null)
      return {
        value: null,
        reason: 'code_may_run_elsewhere',
        read: `none of the ${which} selectors in the code of ${where}${
          router ? ', nor a facet for them by getFacet()' : ''
        }; ${delegates ? `${delegates.at} has a DELEGATECALL` : 'the code delegates'}, so a function may run in code not read`,
      };
    return {
      value: false,
      reason: null,
      read: `none of the ${which} selectors in the code of ${where}, which has no DELEGATECALL`,
    };
  };
  return {
    family: 'evm',
    proxy,
    implementation,
    pausable: flag('pausable'),
    blacklist: flag('blacklist'),
  };
}

/** A holder from an owner()-style answer: an address, none (the zero address), or why it is unknown. */
function holderOf(reply: CallReply | null, read: string, noFunction: string): UniverseAuthority {
  if (!reply?.success) return { holder: null, reason: noFunction, read };
  const a = wordAddress(reply.data);
  if (a === null) return { holder: null, reason: 'answer_not_an_address', read };
  return a === ZERO ? { holder: null, reason: 'none', read } : { holder: a, reason: null, read };
}

const answerText = (name: string, reply: CallReply) => {
  const a = reply.success ? wordAddress(reply.data) : null;
  return a ? `${name} answers ${a}` : `${name} gives no address`;
};

/**
 * `owner` from owner(). `admin`: behind a beacon, owner() of the beacon, which is who may change the
 * code of every proxy of it; else the EIP-1967 admin slot. An empty admin slot is `none` only on a token
 * that is no proxy; on a proxy it is unknown (`uups_upgrade_in_implementation` where the implementation
 * upgrades itself, `admin_slot_empty_on_proxy` otherwise), and on code that delegates without a slot
 * `admin_slot_empty_code_delegates`. owner() and defaultAdmin() of the token are named in the read.
 */
export function evmAuthorities(ctx: {
  owner: CallReply;
  defaultAdmin: CallReply;
  code: CodeContext;
}): Record<'owner' | 'admin', UniverseAuthority> {
  const owner = holderOf(ctx.owner, 'owner()', 'no_owner_function');
  const layout = codeLayout(ctx.code);
  const beacon = slotValue(ctx.code.slots.beacon);
  const implSet = slotValue(ctx.code.slots.implementation).kind !== 'zero';
  if (beacon.kind === 'address' && !implSet)
    return {
      owner,
      admin: holderOf(
        ctx.code.beacon?.owner ?? null,
        `owner() of the EIP-1967 beacon ${beacon.address}`,
        'no_owner_function',
      ),
    };
  const slot = slotValue(ctx.code.slots.admin);
  if (slot.kind === 'address')
    return { owner, admin: { holder: slot.address, reason: null, read: 'EIP-1967 admin slot' } };
  if (slot.kind === 'not_an_address')
    return {
      owner,
      admin: { holder: null, reason: 'slot_holds_no_address', read: 'EIP-1967 admin slot' },
    };
  if (layout.proxy.value === false)
    return { owner, admin: { holder: null, reason: 'none', read: 'EIP-1967 admin slot' } };
  const named = `${answerText('owner()', ctx.owner)}, ${answerText('defaultAdmin()', ctx.defaultAdmin)}; which of them may upgrade is not read`;
  if (layout.proxy.value === null)
    return {
      owner,
      admin: {
        holder: null,
        reason: 'admin_slot_empty_code_delegates',
        read: `EIP-1967 admin slot is empty and the code delegates; ${named}`,
      },
    };
  const upgrades = sigs(
    UPGRADE_SELECTORS,
    new Set(layout.codes.filter((c) => !c.shell).flatMap((c) => c.scan?.selectors ?? [])),
  );
  return {
    owner,
    admin:
      upgrades.length > 0
        ? {
            holder: null,
            reason: 'uups_upgrade_in_implementation',
            read: `EIP-1967 admin slot is empty; the implementation pushes ${upgrades.join(', ')}, so it upgrades itself; ${named}`,
          }
        : {
            holder: null,
            reason: 'admin_slot_empty_on_proxy',
            read: `EIP-1967 admin slot is empty on a proxy whose implementation pushes no upgrade selector; ${named}`,
          },
  };
}

/** The answers of TOKEN_CALLS for one address, by name. */
export type TokenAnswers = {
  decimals: CallReply;
  symbol: CallReply;
  name: CallReply;
  asset: CallReply;
  convertToAssets: CallReply;
  owner: CallReply;
  defaultAdmin: CallReply;
};
export function tokenAnswers(replies: readonly CallReply[]): TokenAnswers {
  if (replies.length !== TOKEN_CALLS.length)
    throw new Error(`tokenAnswers: ${replies.length} answers, ${TOKEN_CALLS.length} calls`);
  const [decimals, symbol, name, asset, convertToAssets, owner, defaultAdmin] = replies as [
    CallReply,
    CallReply,
    CallReply,
    CallReply,
    CallReply,
    CallReply,
    CallReply,
  ];
  return { decimals, symbol, name, asset, convertToAssets, owner, defaultAdmin };
}

/** The calldata of TOKEN_CALLS, in order. */
export const tokenCallData = (): string[] =>
  TOKEN_CALLS.map(([sig, sel]) =>
    sig === 'convertToAssets(uint256)'
      ? `0x${sel}${CONVERT_AMOUNT.toString(16).padStart(64, '0')}`
      : `0x${sel}`,
  );

/**
 * Whether an address answers as a token: decimals() one word of at most 36, and symbol() text. The
 * reason when it does not, which the list counts and never turns into a row.
 */
export function tokenBasics(
  a: TokenAnswers,
):
  | { ok: true; decimals: number; symbol: string; name: string | null }
  | { ok: false; reason: 'no_decimals' | 'no_symbol' } {
  const d = a.decimals.success ? wordUint(a.decimals.data) : null;
  if (d === null || d > 36n) return { ok: false, reason: 'no_decimals' };
  const symbol = a.symbol.success ? decodeAbiText(a.symbol.data) : null;
  if (symbol === null) return { ok: false, reason: 'no_symbol' };
  return {
    ok: true,
    decimals: Number(d),
    symbol,
    name: a.name.success ? decodeAbiText(a.name.data) : null,
  };
}
