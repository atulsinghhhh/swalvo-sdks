/**
 * Stand-in for `open`.
 *
 * ESM-only, like chalk, so Jest can't parse it. And quite separately, a
 * test must never actually launch a browser. This records what would have
 * been opened, so a suite can assert on the URL instead.
 */
export const __opened: string[] = [];

export default async function open(target: string): Promise<{ pid?: number }> {
  __opened.push(target);
  return {};
}

export function __resetOpened(): void {
  __opened.length = 0;
}
