import {
  CATEGORY_CLASS,
  type UniverseAsset,
  UniverseAsset as UniverseAssetSchema,
  type UniverseChain,
  type UniverseList,
  UniverseList as UniverseListSchema,
  type UniverseRead,
  type UniverseSource,
  type UniverseVerdict,
  type UniverseVerdictRule,
  type UniverseVerdicts,
  universeCounts,
} from '@colosseum/schemas';

// The asset universe of one chain from its reads and its reviewed verdicts (PLAN-ASSETS AS.2, AS.3).
// Pure: no I/O, no clock. The chain's command reads the chain and the listings, says which rules each
// token matches and what it derived by its own stated method, and hands both here.

/** What the chain answered about a token: the identity columns of a row. */
export type IdentityRead = Pick<
  UniverseAsset,
  | 'address'
  | 'symbol'
  | 'name'
  | 'nameReason'
  | 'decimals'
  | 'standard'
  | 'standardNote'
  | 'extensions'
  | 'extensionsReason'
  | 'authorities'
  | 'authoritiesReason'
  | 'read'
  | 'listingTags'
  | 'issuerRegistry'
>;

/** What the chain's own files say about a token beside its identity: its pools, its oracle, its shelf. */
export type RowContext = Pick<
  UniverseAsset,
  | 'id'
  | 'oracle'
  | 'oracleReason'
  | 'unverifiedOracles'
  | 'listedIn'
  | 'pools'
  | 'poolsReason'
  | 'tracked'
  | 'attributes'
>;

type VerdictFields = Omit<UniverseVerdict, 'address' | 'symbol'>;
const VERDICT_KEYS = [
  'category',
  'status',
  'statusReason',
  'verdictSource',
  'issuer',
  'issuerReason',
  'issuerKind',
  'underlying',
  'underlyingReason',
  'currency',
  'legTypes',
  'legTypesReason',
  'yieldMechanism',
  'yieldMechanismReason',
  'access',
  'accessReason',
  'mintRedeem',
  'mintRedeemReason',
  'sources',
  'unverified',
] as const satisfies readonly (keyof VerdictFields)[];

export type RowInput = {
  identity: IdentityRead;
  context: RowContext;
  /** The names of the verdict rules this token matches, as the chain's command decided by `match`. */
  rules: readonly string[];
  /** Fields the command derived by a method it states in the list (an underlying from a symbol). */
  derived?: Partial<VerdictFields>;
};

export type UniverseStamp = Pick<UniverseAsset, 'source' | 'fetchedAt' | 'method' | 'provenance'>;

/** The key an address is compared by: as written on Solana, lower case on EVM. */
export const addressKey = (chain: UniverseChain, address: string) =>
  chain === 'solana' ? address : address.toLowerCase();

/**
 * Verdicts that name an address the reads never saw. The command refuses to write a list while any
 * remain, so no verdict stands for a token nobody read.
 */
export function unreadVerdicts(
  verdicts: UniverseVerdicts,
  readAddresses: Iterable<string>,
): UniverseVerdict[] {
  const read = new Set([...readAddresses].map((a) => addressKey(verdicts.chain, a)));
  return verdicts.verdicts.filter((v) => !read.has(addressKey(verdicts.chain, v.address)));
}

/**
 * The verdict fields of one token. Precedence, lowest first: what the command derived, each rule it
 * matches in the table's order, the token's own verdict. Sources and what was not verified are kept
 * from every layer that set a field. Throws when a field is set by none, naming the token and the field.
 */
export function verdictOf(
  verdicts: UniverseVerdicts,
  input: Pick<RowInput, 'identity' | 'rules' | 'derived'>,
): VerdictFields & { decidedBy: string[] } {
  const rules = new Map<string, UniverseVerdictRule>(verdicts.rules.map((r) => [r.name, r]));
  const key = addressKey(verdicts.chain, input.identity.address);
  const own = verdicts.verdicts.find((v) => addressKey(verdicts.chain, v.address) === key);
  const merged: Partial<VerdictFields> = {};
  const sources: UniverseSource[] = [];
  const unverified: string[] = [];
  const decidedBy: string[] = [];
  const take = (fields: Partial<VerdictFields>, by: string) => {
    let any = false;
    for (const k of VERDICT_KEYS) {
      if (k === 'sources' || k === 'unverified') continue;
      if (fields[k] !== undefined) {
        (merged as Record<string, unknown>)[k] = fields[k];
        any = true;
      }
    }
    if (fields.sources) sources.push(...fields.sources);
    if (fields.unverified) unverified.push(...fields.unverified);
    if (any) decidedBy.push(by);
  };
  if (input.derived) take(input.derived, 'derived');
  for (const name of input.rules) {
    const rule = rules.get(name);
    if (!rule) throw new Error(`${input.identity.symbol}: rule ${name} is not in the table`);
    take({ ...rule.fields, sources: rule.sources }, `rule:${name}`);
  }
  if (own) {
    if (own.symbol !== input.identity.symbol)
      throw new Error(
        `${own.address}: the verdict names ${own.symbol}, the chain answers ${input.identity.symbol}`,
      );
    const { address: _a, symbol: _s, ...fields } = own;
    take(fields, 'verdict');
  }
  const missing = VERDICT_KEYS.filter(
    (k) => k !== 'sources' && k !== 'unverified' && !(k in merged),
  );
  if (missing.length > 0)
    throw new Error(
      `${input.identity.symbol} ${input.identity.address}: no verdict sets ${missing.join(', ')}`,
    );
  const seen = new Set<string>();
  const uniqueSources = sources.filter((s) => {
    const k = `${s.url} ${s.readOn}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    ...(merged as VerdictFields),
    sources: uniqueSources,
    unverified: [...new Set(unverified)],
    decidedBy,
  };
}

/** One row of the list: identity, context and verdict joined, the class taken from the category. */
export function universeRow(
  chain: UniverseChain,
  verdicts: UniverseVerdicts,
  input: RowInput,
  stamp: UniverseStamp,
): UniverseAsset {
  const { decidedBy: _d, ...verdict } = verdictOf(verdicts, input);
  const cls = CATEGORY_CLASS[verdict.category];
  const row = {
    id: input.context.id,
    chain,
    ...input.identity,
    ...verdict,
    cls,
    clsReason: cls === null ? `no class takes ${verdict.category}` : null,
    oracle: input.context.oracle,
    oracleReason: input.context.oracleReason,
    unverifiedOracles: input.context.unverifiedOracles,
    listedIn: input.context.listedIn,
    pools: input.context.pools,
    poolsReason: input.context.poolsReason,
    tracked: input.context.tracked,
    attributes: input.context.attributes,
    ...stamp,
  };
  const parsed = UniverseAssetSchema.safeParse(row);
  if (!parsed.success)
    throw new Error(
      `${input.identity.symbol} ${input.identity.address}: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  return parsed.data;
}

/** The list of one chain, its rows sorted by category, then symbol, then address, and its counts. */
export function universeList(args: {
  chain: UniverseChain;
  rows: readonly UniverseAsset[];
  reads: readonly UniverseRead[];
  inputs: Record<string, string>;
  stated: Record<string, string>;
  stamp: UniverseStamp;
}): UniverseList {
  const assets = [...args.rows].sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.symbol.localeCompare(b.symbol) ||
      a.address.localeCompare(b.address),
  );
  return UniverseListSchema.parse({
    chain: args.chain,
    ...args.stamp,
    inputs: args.inputs,
    reads: args.reads,
    counts: universeCounts(assets),
    stated: args.stated,
    assets,
  });
}
