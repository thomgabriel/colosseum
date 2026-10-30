import { notFound } from 'next/navigation';
import { BearingPage } from '../../../../features/bearing/BearingPage';
import { chainInSearch, FIRST } from '../../../../features/bearing/chain';
import { isPageId, PAGES } from '../../../../features/bearing/pages';
import { SeedReads } from '../../../../features/bearing/SeedReads';
import { seedFor } from '../../../../features/bearing/server-seed';
import { bearingDictionary } from '../../../../i18n/bearing';
import { readPreferences } from '../../../../i18n/server';

// One of Bearing's five analytics pages: stocks, commodities, stablecoins, lending, simulation. The
// figures are read in the browser from the risk API (features/bearing/data.ts); the page's first reads
// are made here too and arrive with it (server-seed.ts), so it shows them as soon as it hydrates.

export const dynamicParams = false;

export function generateStaticParams() {
  return PAGES.map((p) => ({ page: p.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  const t = bearingDictionary((await readPreferences()).lang);
  if (!isPageId(page)) return { title: t.head };
  return { title: `${t.pages[page].label} · ${t.head}`, description: t.pages[page].lede };
}

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ page: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { page } = await params;
  if (!isPageId(page)) notFound();
  const named = (await searchParams).chain;
  const chain = chainInSearch(`chain=${typeof named === 'string' ? named : ''}`) ?? FIRST;
  const answers = await seedFor(page, chain);
  return (
    <>
      <SeedReads answers={answers} />
      <BearingPage page={page} />
    </>
  );
}
