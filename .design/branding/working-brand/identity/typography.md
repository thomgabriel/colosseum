# Typography
> Phase: identity | Brand: Tenonfi (provisional; fallback "Tenon") | Generated: 2026-10-01

**Three faces, two families, all free (OFL), all with Latin Extended** for EN, PT and ES (ã õ ç ñ á é í ó ú ü ¿ ¡ ª º). All three ship from Google Fonts or self-hosted, so they can go out before Oct 4.

The split mirrors the voice: **the serif says the answer to a person, the sans explains, the mono cites.** In the voice's terms (answer → reason → risk → action), the serif carries the *answer*, the sans the *reason and action*, and the mono the *source*.

---

## Display: **Newsreader** (Production Type), Display optical size, upright

**Why:** the founder asked for a humanist serif, and Newsreader is one. Its construction follows the pen, so it reads as a person writing to you (Caregiver). At the Display optical size (opsz 36–72) its serifs become sharp, bracketed wedges that read as *cut*, not calligraphic, so the craft stays precise (Sage). It is slightly narrow, which helps the PT and ES headlines that run 20–30% longer. It has a true optical-size axis and a broad weight range.

**Chosen over Source Serif 4** (the mood board's pick): Source Serif is transitional (Fournier-like), cooler and more bookish. Newsreader is warmer at the same sharpness, and that warmth is the Caregiver's 40%.

- **Weights:** 400 for display sentences, 500 for the logotype base and short headlines. Never bold, never italic in brand use (Wealthfront owns the serif-italic flourish, and an italic leans to calligraphy).
- **Use:** the goal sentence on the plan view ("Your apartment fund is on track."), marketing headlines, video title cards, the manifesto, the wordmark.
- **Never:** in the embed, in Bearing, in tables, buttons, labels, or for numbers that carry a pin. The serif is the *one* place for emotional weight, and it's spent once per screen.

## UI and body: **IBM Plex Sans** (+ **Plex Sans Condensed** for dense tables)

**Why:** an engineered grotesk with visible "cut" details. Its angled terminals and squared curves read like tooling marks, so it feels made rather than generated. It is warmer than a neo-grotesk and is used by none of the benchmarked competitors (Söhne, Inter, Satoshi, Plus Jakarta and Gelix are taken). Its tabular figures are excellent. The Condensed width lets Bearing's tables fit without a second family.

- **Weights:** 400 body, 500 labels, buttons and emphasis, 600 for UI headings only. No light weights (they fail on warm grounds) and no heavy weights (they shout).
- **Use:** all product UI, body copy, API docs prose, Bearing, the "Powered by" line, the "Bearing" word in the product lockup.

## Numbers, provenance, code: **IBM Plex Mono**

**Why:** the provenance line (`source · fetched_at · method`), explorer hashes, ISO timestamps, OpenAPI examples and the MOCK label. Same skeleton as Plex Sans, so it's one system. Mono means *cited*: when you see mono, you are looking at a source.

- **Weights:** 400, 500.
- **Use:** provenance popovers, activity log hashes, code, API reference, the MOCK and stale labels, Bearing method versions (`method v1.3 · n=412`).
- **Never** for headlines. Mono-led headlines are the retro-OS / Teiten register.

---

## Rules

- **Sentence case everywhere.** The only all-caps word is **MOCK**. It's a label, not a word.
- **Figures:** tabular and lining in all UI (Plex Sans `tnum`). Old-style figures are allowed only in serif marketing prose. A yield figure is always followed by the pin glyph at cap height.
- **Scale direction:**
  - **Consumer and marketing:** airy, with large contrast between the serif sentence and the sans body. One serif line, then quiet.
  - **Docs:** editorial and measured (swiss-minimalist structure, set flush left and ragged right).
  - **Bearing:** tight and technical, Condensed at small sizes with hairline rows.
- **Alignment:** flush left, ragged right. Never justified, never centred for body text. Video title cards may centre.
- **Language length:** headlines are written in EN to about 80% of their measure so PT and ES fit without shrinking the type.
- **Embed:** Plex is **replaced by the partner's font**. Only the mono provenance line may keep Plex Mono if the partner allows. Otherwise it falls back to the partner's monospace.
- **The logotype is artwork, not type.** It's drawn from Newsreader, outlined, and the fi ligature is custom (logo-directions.md).

## Paid upgrade path (post-hackathon, optional)

Klim **Signifier** (display) and Klim **Untitled Sans** (UI), keeping Plex Mono, if the brand later wants a more ownable voice. Avoid Söhne (Gauntlet) and Inter (Chaos Labs, Peaks). Same roles, same rules. Not before the name is final.

Technical enrichment (modular scale, fluid sizes, line-heights, font loading and subsetting for latin-ext) is handled by `/gsp-typography --enrich`.
