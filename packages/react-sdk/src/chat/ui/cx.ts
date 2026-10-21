/** Joins class names, skipping empty ones. Tiny on purpose: no dependency for this. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}
