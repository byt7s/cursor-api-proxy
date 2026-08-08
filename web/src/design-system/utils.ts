/** Joins truthy class names; the only styling helper components should need. */
export function cx(
  ...parts: Array<string | false | null | undefined>
): string | undefined {
  const joined = parts.filter(Boolean).join(" ");
  return joined || undefined;
}

let idCounter = 0;

/** Stable-enough id generator for label/description wiring in tests and SSR-free code. */
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}
