# Design system

Everything the dashboard renders comes from here. The system has two layers:

1. **Tokens** — `tokens.css` (CSS custom properties) and `tokens.ts` (typed
   mirror for values TypeScript needs).
2. **Components** — `components/*.tsx`, each paired with a `*.module.css` that
   references tokens only.

## Rules

- **Never hardcode a colour, size, radius, shadow, duration or z-index** in a
  component stylesheet. If a value is missing, add a token first.
- Component CSS may only use `var(--…)` for visual values. The single exception
  is `tokens.css` itself, plus intrinsically content-sized values such as
  `ch`/`%` widths and `1px` hairlines expressed through `--border-width`.
- Prefer composition over new components: `Stack`, `Inline`, `Grid` and
  `Container` cover almost all layout needs.
- Variants are exposed as props *and* mirrored onto `data-*` attributes
  (`data-variant`, `data-size`, `data-tone`) so behaviour can be asserted in
  tests without depending on hashed CSS module class names.
- Every interactive component must be keyboard operable and carry the right
  `aria-*` wiring. Focus rings come from the global `:focus-visible` rule in
  `tokens.css`.

## Token categories

| Category | Examples |
|---|---|
| Background layers | `--color-bg`, `--color-surface`, `--color-surface-raised`, `--color-surface-sunken`, `--color-overlay` |
| Borders | `--color-border`, `--color-border-subtle`, `--color-border-strong`, `--border-width` |
| Text | `--color-text`, `--color-text-secondary`, `--color-text-muted`, `--color-text-inverse` |
| Brand / accent | `--color-brand`, `--color-brand-hover`, `--color-brand-fg`, `--color-brand-bg`, `--color-brand-border`, `--color-accent` |
| Semantic | `--color-{success,warning,danger,info,neutral}` each with `-fg`, `-bg`, `-border` |
| Interaction | `--color-focus-ring`, `--color-hover-overlay`, `--color-active-overlay`, `--color-selected-bg` |
| Spacing | `--space-0` … `--space-16` (4px base) |
| Radii | `--radius-sm|md|lg|full` |
| Shadows | `--shadow-sm|md|lg` |
| Typography | `--font-family-sans|mono`, `--font-size-xs` … `--font-size-3xl`, `--line-height-*`, `--font-weight-*`, `--letter-spacing-*` |
| Sizes | `--control-h-sm|md|lg`, `--icon-size-*`, `--sidebar-width`, `--header-height`, `--container-max-width` |
| Z-index | `--z-base|sticky|sidebar|dropdown|overlay|modal|toast|tooltip` |
| Motion | `--duration-instant|fast|normal|slow`, `--easing-standard|decelerate|accelerate` |
| Breakpoints | `--breakpoint-sm|md|lg|xl` (640/768/1024/1280) — documented constants; media queries repeat the literals because custom properties cannot be used in `@media` |

## Theming

Dark is the default (`:root`). Light overrides only the colour layer under
`[data-theme="light"]`. The attribute lives on `<html>`, is set before first
paint by an inline script in `web/index.html`, and is persisted in
`localStorage` under `cursor-api-proxy.theme` by the `useTheme` hook.

## Component inventory

- **Layout** — `AppShell`, `Sidebar`, `SidebarSection`, `SidebarNavItem`,
  `Topbar`, `PageHeader`, `Container`, `Stack`, `Inline`, `Grid`, `Divider`
- **Data** — `Card` (+ `CardHeader`, `CardBody`, `CardFooter`), `StatCard`,
  `Table`, `KeyValueList`, `Badge`, `StatusDot`, `LogViewer`, `CodeBlock`
  (+ `InlineCode`), `Skeleton`, `EmptyState`
- **Forms** — `Button`, `IconButton`, `Input`, `PasswordInput`, `Textarea`,
  `Select`, `Checkbox`, `Switch`, `FormField`
- **Feedback / overlay** — `Modal`, `ConfirmDialog`, `Toast` via
  `ToastProvider` + `useToast`, `Tooltip`, `Spinner`, `Alert`

## Adding a component

1. Create `components/Thing.tsx` and `components/Thing.module.css`.
2. Style using tokens only; add any missing token to `tokens.css` (and
   `tokens.ts` when TypeScript needs the value).
3. Expose variants as props, mirror them onto `data-*` attributes.
4. Wire accessibility: labels, `aria-*`, keyboard handling, focus management.
5. Export the component and its props type from `index.ts`.
6. Add a behaviour test under `web/src/design-system/__tests__/`.
