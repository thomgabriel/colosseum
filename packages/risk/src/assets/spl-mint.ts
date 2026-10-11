import { SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM } from '../lending/tx';
import { Reader } from '../pools/bytes';

// The identity of a Solana token from its mint account and its metadata account (PLAN-ASSETS AS.2).
// Pure: bytes in, fields out. No I/O, no clock, no SDK. The layouts are those of the SPL Token and
// Token-2022 programs (a mint is 82 bytes; a Token-2022 mint with extensions is padded to 165 bytes,
// then one account-type byte, then type-length-value entries) and of Metaplex Token Metadata
// (key, update authority, mint, then the name, symbol and uri as borsh strings). Checked against live
// accounts frozen in fixtures/risk/assets/ (tests/risk-assets-solana.test.ts).

export const METAPLEX_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

const MINT_LEN = 82;
/** A Token-2022 mint with extensions is padded to the length of a token account before its type byte. */
const ACCOUNT_LEN = 165;
const ACCOUNT_TYPE_MINT = 1;

/** Token-2022's `ExtensionType`, by its u16 discriminant, as the program numbers them. */
export const TOKEN_2022_EXTENSIONS: Record<number, string> = {
  0: 'uninitialized',
  1: 'transferFeeConfig',
  2: 'transferFeeAmount',
  3: 'mintCloseAuthority',
  4: 'confidentialTransferMint',
  5: 'confidentialTransferAccount',
  6: 'defaultAccountState',
  7: 'immutableOwner',
  8: 'memoTransfer',
  9: 'nonTransferable',
  10: 'interestBearingConfig',
  11: 'cpiGuard',
  12: 'permanentDelegate',
  13: 'nonTransferableAccount',
  14: 'transferHook',
  15: 'transferHookAccount',
  16: 'confidentialTransferFeeConfig',
  17: 'confidentialTransferFeeAmount',
  18: 'metadataPointer',
  19: 'tokenMetadata',
  20: 'groupPointer',
  21: 'tokenGroup',
  22: 'groupMemberPointer',
  23: 'tokenGroupMember',
  24: 'confidentialMintBurn',
  25: 'scaledUiAmountConfig',
  26: 'pausableConfig',
  27: 'pausableAccount',
};

export type TokenMetadataFields = {
  /** Null where the field holds the zero key (nobody may change the metadata). */
  updateAuthority: string | null;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
};

export type DecodedMint = {
  program: 'spl' | 'token2022';
  decimals: number;
  isInitialized: boolean;
  /** Null where the account's option says none. */
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Token-2022 extensions by name, in the order the account holds them. Empty for a classic mint. */
  extensions: string[];
  /** Discriminants the table above does not name, kept so a new extension is never dropped silently. */
  unknownExtensions: number[];
  /** The permanentDelegate extension's key: undefined without the extension, null where it is zero. */
  permanentDelegate: string | null | undefined;
  /** The metadataPointer extension: undefined without it. */
  metadataPointer: { authority: string | null; address: string | null } | undefined;
  /** The tokenMetadata extension, in the mint itself: undefined without it. */
  tokenMetadata: TokenMetadataFields | undefined;
  /** The defaultAccountState extension: the state a new token account starts in. Undefined without it. */
  defaultAccountState: 'uninitialized' | 'initialized' | 'frozen' | undefined;
  /** The pausableConfig extension: whether transfers are paused now. Undefined without it. */
  paused: boolean | undefined;
  /** The transferHook extension's program: null where none is set. Undefined without the extension. */
  transferHookProgram: string | null | undefined;
};

const ACCOUNT_STATES = ['uninitialized', 'initialized', 'frozen'] as const;

const ZERO_KEY = '11111111111111111111111111111111';
const optionalKey = (r: Reader, o: number): string | null => {
  const k = r.pubkey(o);
  return k === ZERO_KEY ? null : k;
};

/** A COption<Pubkey>: a u32 tag (0 none, 1 some) and 32 bytes. */
const cOptionKey = (r: Reader, o: number): string | null => {
  const tag = r.u32(o);
  if (tag === 0) return null;
  if (tag !== 1) throw new Error(`bad COption tag ${tag} at ${o}`);
  return r.pubkey(o + 4);
};

const utf8 = new TextDecoder('utf-8', { fatal: false });

/** A borsh string: a u32 length, then the bytes. Returns the string and the offset after it. */
function borshString(b: Uint8Array, r: Reader, o: number): [string, number] {
  if (o + 4 > b.length) throw new Error(`string length past the account at ${o}`);
  const n = r.u32(o);
  if (o + 4 + n > b.length) throw new Error(`string of ${n} bytes past the account at ${o}`);
  return [utf8.decode(b.subarray(o + 4, o + 4 + n)), o + 4 + n];
}

/** Metaplex pads the name, symbol and uri with NUL bytes to fixed sizes; the padding is not the value. */
export const stripNul = (s: string) => s.replace(/\0+$/u, '');

/** The tokenMetadata extension's value (spl-token-metadata-interface `TokenMetadata`). */
export function decodeTokenMetadata(value: Uint8Array): TokenMetadataFields {
  const r = new Reader(value);
  const updateAuthority = optionalKey(r, 0);
  const mint = r.pubkey(32);
  const [name, o1] = borshString(value, r, 64);
  const [symbol, o2] = borshString(value, r, o1);
  const [uri] = borshString(value, r, o2);
  return { updateAuthority, mint, name, symbol, uri };
}

/** A mint account of either token program. Throws on an account of another program or of another length. */
export function decodeMint(owner: string, data: Uint8Array): DecodedMint {
  const program =
    owner === SPL_TOKEN_PROGRAM ? 'spl' : owner === SPL_TOKEN_2022_PROGRAM ? 'token2022' : null;
  if (!program) throw new Error(`not a token program: ${owner}`);
  if (data.length < MINT_LEN) throw new Error(`a mint is ${MINT_LEN} bytes, got ${data.length}`);
  const r = new Reader(data);
  const out: DecodedMint = {
    program,
    mintAuthority: cOptionKey(r, 0),
    decimals: r.u8(44),
    isInitialized: r.u8(45) === 1,
    freezeAuthority: cOptionKey(r, 46),
    extensions: [],
    unknownExtensions: [],
    permanentDelegate: undefined,
    metadataPointer: undefined,
    tokenMetadata: undefined,
    defaultAccountState: undefined,
    paused: undefined,
    transferHookProgram: undefined,
  };
  if (data.length === MINT_LEN) return out;
  if (program === 'spl')
    throw new Error(`an SPL Token mint is ${MINT_LEN} bytes, got ${data.length}`);
  if (data.length <= ACCOUNT_LEN) throw new Error(`a Token-2022 mint of ${data.length} bytes`);
  if (r.u8(ACCOUNT_LEN) !== ACCOUNT_TYPE_MINT)
    throw new Error(`account type ${r.u8(ACCOUNT_LEN)} is not a mint`);
  let o = ACCOUNT_LEN + 1;
  while (o + 4 <= data.length) {
    const type = r.u16(o);
    const len = r.u16(o + 2);
    if (type === 0 && len === 0) break; // the zeroed tail of a reallocated account
    const value = data.subarray(o + 4, o + 4 + len);
    if (value.length !== len) throw new Error(`extension ${type} runs past the account`);
    const name = TOKEN_2022_EXTENSIONS[type];
    if (name === undefined) out.unknownExtensions.push(type);
    else out.extensions.push(name);
    const v = new Reader(value);
    if (type === 12) out.permanentDelegate = optionalKey(v, 0);
    if (type === 18)
      out.metadataPointer = { authority: optionalKey(v, 0), address: optionalKey(v, 32) };
    if (type === 19) out.tokenMetadata = decodeTokenMetadata(value);
    if (type === 6) {
      const st = ACCOUNT_STATES[v.u8(0)];
      if (!st) throw new Error(`default account state ${v.u8(0)}`);
      out.defaultAccountState = st;
    }
    if (type === 14) out.transferHookProgram = optionalKey(v, 32);
    if (type === 26) out.paused = v.u8(32) === 1;
    o += 4 + len;
  }
  return out;
}

export type DecodedMetaplex = {
  updateAuthority: string;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
};

/** Metaplex's `MetadataV1` account (key 4): the update authority, the mint, then name, symbol and uri. */
export function decodeMetaplexMetadata(owner: string, data: Uint8Array): DecodedMetaplex {
  if (owner !== METAPLEX_METADATA_PROGRAM) throw new Error(`not a metadata account: ${owner}`);
  if (data[0] !== 4) throw new Error(`metadata key ${data[0]} is not MetadataV1`);
  const r = new Reader(data);
  const updateAuthority = r.pubkey(1);
  const mint = r.pubkey(33);
  const [name, o1] = borshString(data, r, 65);
  const [symbol, o2] = borshString(data, r, o1);
  const [uri] = borshString(data, r, o2);
  return {
    updateAuthority,
    mint,
    name: stripNul(name),
    symbol: stripNul(symbol),
    uri: stripNul(uri),
  };
}

/** One account as read: its owner and its bytes, or null where the chain holds none. */
export type AccountBytes = { owner: string; data: Uint8Array } | null;

/** What a builder hands in for one mint: the mint's read, its metadata account's read, its listing row. */
export type SolanaIdentityInput = {
  address: string;
  mint: NonNullable<AccountBytes>;
  /** The slot and time of the getMultipleAccounts call that returned the mint. */
  slot: number;
  at: string;
  /** The Metaplex metadata account at the mint's address-derived key, where it was read. */
  metaplex: AccountBytes;
  /** The listing's symbol and name, used only where the chain holds neither. */
  listing: { symbol: string; name: string | null } | null;
  listingTags: string[];
};

/** The identity columns of a universe row, read from a mint (`IdentityRead` in ./universe). */
export type SolanaIdentity = {
  address: string;
  symbol: string;
  name: string | null;
  nameReason: string | null;
  decimals: number;
  standard: 'spl' | 'token2022';
  standardNote: null;
  extensions: { family: 'solana'; names: string[] };
  extensionsReason: null;
  authorities: Record<
    'mint' | 'freeze' | 'permanentDelegate',
    { holder: string | null; reason: string | null; read: string }
  >;
  authoritiesReason: null;
  read: {
    method: string;
    at: string;
    height: number;
    symbolFrom: 'metaplex' | 'token_metadata_extension' | 'listing';
  };
  listingTags: string[];
  issuerRegistry: null;
};

const authority = (holder: string | null, read: string) => ({
  holder,
  reason: holder === null ? 'none' : null,
  read,
});

/**
 * The identity of one token. The symbol and name come from the mint's own tokenMetadata extension when it
 * holds one for itself, else from its Metaplex metadata account, else from the listing (said in
 * `read.symbolFrom`); a name the chain holds as an empty string is null with its reason. Throws when the
 * account is not a mint of either token program, or when no source gives a symbol.
 */
export function solanaIdentity(input: SolanaIdentityInput): SolanaIdentity & {
  /** What was decoded, for the builder's own checks and counts (not a row field). */
  decoded: DecodedMint;
  metadataUri: string | null;
  updateAuthority: string | null;
} {
  const m = decodeMint(input.mint.owner, input.mint.data);
  if (!m.isInitialized) throw new Error(`${input.address}: the mint is not initialised`);
  let symbol: string | null = null;
  let name: string | null = null;
  let uri: string | null = null;
  let updateAuthority: string | null = null;
  let symbolFrom: SolanaIdentity['read']['symbolFrom'] = 'listing';
  const own = m.tokenMetadata;
  if (own && own.mint === input.address && own.symbol.length > 0) {
    symbol = own.symbol;
    name = own.name;
    uri = own.uri;
    updateAuthority = own.updateAuthority;
    symbolFrom = 'token_metadata_extension';
  } else if (input.metaplex) {
    const mp = decodeMetaplexMetadata(input.metaplex.owner, input.metaplex.data);
    if (mp.mint !== input.address)
      throw new Error(`${input.address}: its metadata account names mint ${mp.mint}`);
    if (mp.symbol.length > 0) {
      symbol = mp.symbol;
      name = mp.name;
      uri = mp.uri;
      updateAuthority = mp.updateAuthority;
      symbolFrom = 'metaplex';
    }
  }
  let nameReason: string | null = null;
  if (symbol === null) {
    if (!input.listing) throw new Error(`${input.address}: no symbol on chain and no listing`);
    symbol = input.listing.symbol;
    name = null;
    nameReason = 'no_metadata_on_chain';
  } else if (name === null || name.length === 0) {
    name = null;
    nameReason = 'empty_on_chain';
  }
  const permanentDelegate =
    m.program === 'spl'
      ? { holder: null, reason: 'none', read: 'spl-token: the program has no permanent delegate' }
      : m.permanentDelegate === undefined
        ? { holder: null, reason: 'none', read: 'no permanentDelegate extension on the mint' }
        : authority(m.permanentDelegate, 'extension permanentDelegate');
  return {
    address: input.address,
    symbol,
    name,
    nameReason,
    decimals: m.decimals,
    standard: m.program,
    standardNote: null,
    extensions: {
      family: 'solana',
      names: [...m.extensions, ...m.unknownExtensions.map((t) => `unknown:${t}`)],
    },
    extensionsReason: null,
    authorities: {
      mint: authority(m.mintAuthority, 'mint.mintAuthority'),
      freeze: authority(m.freezeAuthority, 'mint.freezeAuthority'),
      permanentDelegate,
    },
    authoritiesReason: null,
    read: { method: 'getMultipleAccounts', at: input.at, height: input.slot, symbolFrom },
    listingTags: input.listingTags,
    issuerRegistry: null,
    decoded: m,
    metadataUri: uri,
    updateAuthority,
  };
}
