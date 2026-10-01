# Guidelines
> Phase: guidelines (Pass 1: Core) | Brand: Tenonfi (provisional; fallback "Tenon"; slug `working-brand`) | Generated: 2026-10-01

## Core

| File | Description |
|------|-------------|
| [working-brand.yml](./working-brand.yml) | Style preset: the single source of truth. Its tokens follow the shadcn-flat schema and are validated with `theme-css.js` |
| [STYLE.md](./STYLE.md) | Agent contract, rendered from the .yml. Binding rules, patterns, constraints, effects, bold bets and Tailwind v4 hints |
| [guidelines.html](./guidelines.html) | Visual brand guide (open it in a browser). Light and dark: use the toggle, or open with `?theme=dark` |

## Components

Pass 2 (pending): `components/token-mapping.md` (Tailwind v4 `@theme`, no shadcn yet), plus override and custom specs for the provenance pin, the MOCK plate, the goal card, the plan leg, the disclaimer, the embed shell and the Bearing tile.

## Token decisions made in this pass

- `accent` is shadcn's hover/selected surface (paper-sunk / char-2), not a second hue. The memorable colour is `primary` (hardwood / hinoki).
- `border` = hair (decoration only) and `input` = member (control edges), so shadcn cards get hairlines and form controls meet 3:1.
- `--radius` is 2px. shadcn's `calc(var(--radius) - 4px)` clamps to 0, which is intended because joinery is square.
- `chart-1…4` are the plan legs (wood-400 `#9D7751` on light, per the colour pass), and `chart-5` is the base-case line (ink / washi).
- Hover is wood-600 `#63482E` on light, and `#D7C09E` (the midpoint of hinoki and hinoki-deep) on dark. Pressed uses heartwood / hinoki-deep.
- Hatch pitch is 6px in UI, 3px in glyphs and 4px in SVG drawings. The colour pass supersedes the 4px from imagery for UI surfaces.
- All shadows are `none`. Depth comes from three warm layers plus hairlines.
- The guidelines hero is always on warm black (an inverted section). It "feels alive" through the J1 lock animation (seat, then pin), which runs once, instead of the template's animated gradient (the brand bans gradients and ambient loops).
