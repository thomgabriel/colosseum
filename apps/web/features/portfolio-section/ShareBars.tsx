'use client';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinLabels, PinSource } from '../../components/ui/provenance';
import { Composition } from '../shared/Composition';

// Shares of one whole, largest first, as a ring beside its list (Composition.tsx, gate WEIGHTS-RING):
// each row with its name, its percentage as the caller rounded it, and its dollars with their pin. The
// ring is a picture of figures written beside it.

export type ShareRow = {
  key: string;
  /** The share's name as a person reads it. */
  name: string;
  /** Its dollars, already formatted. */
  dollars: string;
  /** Its percentage of the whole, already formatted. */
  percent: string;
  /** The same share in basis points: the length of the bar. */
  bps: number;
};

export function ShareBars({
  caption,
  valueHeader,
  by,
  rows,
  obs,
  pinLabels,
}: {
  /** What the whole is split by: for a test and a style to find the list. */
  by: 'underlying' | 'issuer';
  /** Largest first. */
  rows: readonly ShareRow[];
  /** The stamp of the sums: every row's dollars carry it. */
  obs: PinSource;
  pinLabels: Partial<PinLabels>;
  /** The table's name, for a screen reader: the heading over it. */
  caption: string;
  /** The head of the dollars' column. */
  valueHeader: string;
}) {
  return (
    <div data-ui="shares" data-by={by} className="min-w-0">
      <Composition
        labels={{ caption: caption }}
        columns={[{ key: 'dollars', header: valueHeader, numeric: true }]}
        items={rows.map((row) => ({
          key: row.key,
          name: row.name,
          bps: row.bps,
          label: row.percent,
          cells: {
            dollars: (
              <span data-ui="share-dollars">
                <ProvenancePin value={row.dollars} obs={obs} labels={pinLabels} />
              </span>
            ),
          },
        }))}
      />
    </div>
  );
}
