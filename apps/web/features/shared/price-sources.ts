// Where a vault's prices come from, as its details list them. The API writes each price's `source` as
// free text for the record; the Solana reader writes one per held asset, "price account <account>
// (Scope layout, owner <owner>), entry <n>" (packages/chain-solana/src/vault/reader.ts), so a vault
// of three assets repeats the same account three times. Those are folded into one line per account,
// with its entries. A source written any other way is kept word for word: nothing is guessed at.

export type PriceSourceLine =
  | { kind: 'account'; layout: string; account: string; owner: string; entries: number[] }
  | { kind: 'text'; text: string };

const ACCOUNT_ENTRY = /^price account (\S+) \(([^,()]+?) layout, owner (\S+)\), entry (\d+)$/;

/** Each distinct source once: an account's entries on its one line, any other text as written. */
export function priceSourceLines(sources: readonly string[]): PriceSourceLine[] {
  const lines: PriceSourceLine[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const match = ACCOUNT_ENTRY.exec(source.trim());
    if (!match) {
      if (!seen.has(source)) lines.push({ kind: 'text', text: source });
      seen.add(source);
      continue;
    }
    const [, account = '', layout = '', owner = '', entry = ''] = match;
    const index = Number(entry);
    const line = lines.find(
      (l) =>
        l.kind === 'account' && l.account === account && l.layout === layout && l.owner === owner,
    );
    if (line?.kind === 'account') {
      if (!line.entries.includes(index)) line.entries.push(index);
    } else lines.push({ kind: 'account', layout, account, owner, entries: [index] });
  }
  for (const line of lines) if (line.kind === 'account') line.entries.sort((a, b) => a - b);
  return lines;
}
