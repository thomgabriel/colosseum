export function ProvenanceBadge({ value }: { value?: string | null }) {
  if (!value || value === 'live')
    return <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800">live</span>;
  return (
    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold uppercase text-amber-900">
      {value === 'mock' ? 'MOCK' : value}
    </span>
  );
}
