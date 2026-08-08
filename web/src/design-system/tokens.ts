/**
 * Typed mirror of the values in `tokens.css` that TypeScript needs at runtime
 * (media queries, timers, inline z-index). Keep both files in sync — CSS stays
 * the source of truth for anything that can be expressed as a custom property.
 */

export const space = {
  0: "var(--space-0)",
  1: "var(--space-1)",
  2: "var(--space-2)",
  3: "var(--space-3)",
  4: "var(--space-4)",
  5: "var(--space-5)",
  6: "var(--space-6)",
  7: "var(--space-7)",
  8: "var(--space-8)",
  10: "var(--space-10)",
  12: "var(--space-12)",
  14: "var(--space-14)",
  16: "var(--space-16)",
} as const;

export type SpaceToken = keyof typeof space;

/** Pixel values behind the spacing scale, for layout math in TS. */
export const spacePx: Record<SpaceToken, number> = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  10: 40,
  12: 48,
  14: 56,
  16: 64,
};

export const breakpoints = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

export type Breakpoint = keyof typeof breakpoints;

export const zIndex = {
  base: 0,
  sticky: 100,
  sidebar: 200,
  dropdown: 300,
  overlay: 400,
  modal: 500,
  toast: 600,
  tooltip: 700,
} as const;

export const duration = {
  instant: 80,
  fast: 120,
  normal: 200,
  slow: 320,
} as const;

export const easing = {
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  decelerate: "cubic-bezier(0, 0, 0, 1)",
  accelerate: "cubic-bezier(0.3, 0, 1, 1)",
} as const;

export const radius = {
  sm: "var(--radius-sm)",
  md: "var(--radius-md)",
  lg: "var(--radius-lg)",
  full: "var(--radius-full)",
} as const;

export const controlHeight = {
  sm: "var(--control-h-sm)",
  md: "var(--control-h-md)",
  lg: "var(--control-h-lg)",
} as const;

export type ControlSize = keyof typeof controlHeight;

export const semanticTones = [
  "neutral",
  "brand",
  "success",
  "warning",
  "danger",
  "info",
] as const;

export type Tone = (typeof semanticTones)[number];

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];
