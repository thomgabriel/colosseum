import type { FxObservation } from '@colosseum/schemas';

/** BCB SGS series: 1 = PTAX USD/BRL sell (daily), 11 = Selic daily factor (%), 12 = CDI daily factor (%). */
const SERIES = { 'USD/BRL': 1, SELIC_DAILY: 11, CDI_DAILY: 12 } as const;

export async function fetchFx(): Promise<FxObservation[]> {
  const out: FxObservation[] = [];
  for (const [pair, id] of Object.entries(SERIES)) {
    const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${id}/dados/ultimos/1?formato=json`;
    const rows = (await (await fetch(url)).json()) as Array<{ data: string; valor: string }>;
    const last = rows[0];
    if (!last) continue;
    const value = Number(last.valor.replace(',', '.'));
    const daily = pair.endsWith('_DAILY');
    out.push({
      pair,
      value: daily ? value / 100 : value,
      source: url,
      method: daily ? 'bcb_sgs_daily_factor_pct' : 'bcb_sgs_ptax_sell',
      fetchedAt: new Date().toISOString(),
      provenance: 'live',
    });
    if (daily) {
      // Annualised on the Brazilian 252-business-day convention, labelled as such.
      out.push({
        pair: pair.replace('_DAILY', '_ANNUAL'),
        value: (1 + value / 100) ** 252 - 1,
        source: url,
        method: 'bcb_sgs_daily_annualised_252',
        fetchedAt: new Date().toISOString(),
        provenance: 'live',
      });
    }
  }
  return out;
}
