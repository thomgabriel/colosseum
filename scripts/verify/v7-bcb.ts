import { nowIso, print } from '../lib.js';

// V7: BCB SGS series. 1 = PTAX USD/BRL sell (daily), 11 = Selic daily factor, 12 = CDI daily factor.
const ids: Record<string, number> = { PTAX_USDBRL: 1, SELIC_DAILY: 11, CDI_DAILY: 12 };
const value: Record<string, unknown> = {};
for (const [name, id] of Object.entries(ids)) {
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${id}/dados/ultimos/1?formato=json`;
  const j = (await (await fetch(url)).json()) as Array<{ data: string; valor: string }>;
  value[name] = { series: id, url, last: j[0] ?? null };
}
print({
  id: 'V7',
  item: 'FX and rate data (BCB SGS)',
  status: Object.values(value).every((v) => (v as { last: unknown }).last) ? 'pass' : 'fail',
  how: 'api.bcb.gov.br SGS ultimos/1',
  value,
  fetchedAt: nowIso(),
});
