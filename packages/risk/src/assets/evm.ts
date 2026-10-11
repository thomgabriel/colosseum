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

/** Every selector looked for in code, sorted: what a frozen code scan was reduced to. */
export const WATCHED_SELECTORS: readonly string[] = [
  ...new Set([...CODE_SELECTORS.pausable, ...CODE_SELECTORS.blacklist].map(([, s]) => s)),
].sort();

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
};

const sigs = (selectors: readonly (readonly [string, string])[], found: Set<string>) =>
  selectors.filter(([, s]) => found.has(s)).map(([sig]) => sig);

/** Whether the token is an upgradeable proxy and to what, where its code is, and what that code can do. */
export function evmExtensions(ctx: CodeContext): UniverseExtensions & { family: 'evm' } {
  const impl = slotValue(ctx.slots.implementation);
  const beacon = slotValue(ctx.slots.beacon);
  let proxy: Flag;
  let implementation: string | null = null;
  /** Where the code that runs is, and its label for a `read`. */
  let codes: Array<{ at: string; scan: CodeScan | null }> = [{ at: 'the token', scan: ctx.own }];
  if (impl.kind === 'address') {
    proxy = {
      value: true,
      reason: null,
      read: `EIP-1967 implementation slot holds ${impl.address}`,
    };
    implementation = impl.address;
    codes = [
      { at: 'the proxy', scan: ctx.own },
      { at: `the implementation ${impl.address}`, scan: ctx.codeAt(impl.address) },
    ];
  } else if (beacon.kind === 'address') {
    const answered = ctx.beacon?.implementation.success
      ? wordAddress(ctx.beacon.implementation.data)
      : null;
    if (answered && answered !== ZERO) {
      proxy = {
        value: true,
        reason: null,
        read: `EIP-1967 beacon slot holds ${beacon.address}, whose implementation() is ${answered}`,
      };
      implementation = answered;
      codes = [
        { at: 'the proxy', scan: ctx.own },
        { at: `the implementation ${answered}`, scan: ctx.codeAt(answered) },
      ];
    } else {
      proxy = {
        value: null,
        reason: 'beacon_gave_no_implementation',
        read: `EIP-1967 beacon slot holds ${beacon.address}; its implementation() gave no address`,
      };
      codes = [{ at: 'the proxy', scan: ctx.own }];
    }
  } else if (impl.kind === 'not_an_address' || beacon.kind === 'not_an_address') {
    proxy = {
      value: null,
      reason: 'slot_holds_no_address',
      read: 'an EIP-1967 implementation or beacon slot holds a word that is not an address',
    };
  } else if (ctx.own.minimalProxyTarget) {
    const target = ctx.own.minimalProxyTarget;
    proxy = {
      value: false,
      reason: null,
      read: `EIP-1967 slots are zero; the code is an EIP-1167 clone of ${target}, which cannot be upgraded`,
    };
    codes = [{ at: `the clone's target ${target}`, scan: ctx.codeAt(target) }];
  } else if (ctx.own.delegatecall) {
    proxy = {
      value: null,
      reason: 'delegatecall_without_eip1967_slot',
      read: 'EIP-1967 slots are zero and the code has a DELEGATECALL: where it forwards was not read',
    };
  } else
    proxy = {
      value: false,
      reason: null,
      read: 'EIP-1967 implementation, admin and beacon slots are zero and the code has no DELEGATECALL',
    };

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
    if (proxy.value === null)
      return {
        value: null,
        reason: 'code_may_run_elsewhere',
        read: `none of the ${which} selectors in the code of ${where}, which may run other code`,
      };
    return {
      value: false,
      reason: null,
      read: `none of the ${which} selectors in the code of ${where}`,
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

/**
 * `owner` from owner(); `admin` from the EIP-1967 admin slot, or, behind a beacon, from owner() of the
 * beacon, which is who may change the code every proxy of it runs.
 */
export function evmAuthorities(ctx: {
  owner: CallReply;
  slots: CodeContext['slots'];
  beacon: CodeContext['beacon'];
}): Record<'owner' | 'admin', UniverseAuthority> {
  const owner = holderOf(ctx.owner, 'owner()', 'no_owner_function');
  const beacon = slotValue(ctx.slots.beacon);
  const implSet = slotValue(ctx.slots.implementation).kind !== 'zero';
  if (beacon.kind === 'address' && !implSet)
    return {
      owner,
      admin: holderOf(
        ctx.beacon?.owner ?? null,
        `owner() of the EIP-1967 beacon ${beacon.address}`,
        'no_owner_function',
      ),
    };
  const slot = slotValue(ctx.slots.admin);
  const read = 'EIP-1967 admin slot';
  const admin: UniverseAuthority =
    slot.kind === 'zero'
      ? { holder: null, reason: 'none', read }
      : slot.kind === 'address'
        ? { holder: slot.address, reason: null, read }
        : { holder: null, reason: 'slot_holds_no_address', read };
  return { owner, admin };
}

/** The six answers of TOKEN_CALLS for one address, by name. */
export type TokenAnswers = {
  decimals: CallReply;
  symbol: CallReply;
  name: CallReply;
  asset: CallReply;
  convertToAssets: CallReply;
  owner: CallReply;
};
export function tokenAnswers(replies: readonly CallReply[]): TokenAnswers {
  if (replies.length !== TOKEN_CALLS.length)
    throw new Error(`tokenAnswers: ${replies.length} answers, ${TOKEN_CALLS.length} calls`);
  const [decimals, symbol, name, asset, convertToAssets, owner] = replies as [
    CallReply,
    CallReply,
    CallReply,
    CallReply,
    CallReply,
    CallReply,
  ];
  return { decimals, symbol, name, asset, convertToAssets, owner };
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
