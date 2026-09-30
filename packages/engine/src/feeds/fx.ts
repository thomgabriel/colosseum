import type { FxObservation } from '@colosseum/schemas';

/** BCB SGS series: 1 = PTAX USD/BRL sell (daily), 11 = Selic daily factor (%), 12 = CDI daily factor (%). */
const SERIES = { 'USD/BRL': 1, SELIC_DAILY: 11, CDI_DAILY: 12 } as const;

async function fetchSeries(url: string): Promise<Array<{ data: string; valor: string }>> {
  // The BCB API occasionally answers with an XML error page; retry once, then report.
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    if (res.ok && text.trim().startsWith('['))
      return JSON.parse(text) as Array<{ data: string; valor: string }>;
    lastErr = `${res.status} ${text.slice(0, 80)}`;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`BCB SGS ${url}: ${lastErr}`);
}

/** Returns whatever series answered; a failed series is reported in `errors`, never silently zeroed. */
export async function fetchFx(): Promise<FxObservation[] & { errors?: string[] }> {
  const out: FxObservation[] & { errors?: string[] } = [];
  const errors: string[] = [];
  for (const [pair, id] of Object.entries(SERIES)) {
    const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${id}/dados/ultimos/1?formato=json`;
    let rows: Array<{ data: string; valor: string }>;
    try {
      rows = await fetchSeries(url);
    } catch (e) {
      errors.push(String(e).slice(0, 160));
      continue;
    }
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
  if (errors.length) out.errors = errors;
  return out;
}
