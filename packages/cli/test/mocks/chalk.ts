/**
 * Identity stand-in for `chalk`.
 *
 * Two reasons this is a stub instead of a transform of the real package:
 *
 * 1. chalk@5 is ESM-only and imports `#ansi-styles`, a subpath import
 *    Jest's CommonJS transform cannot resolve. Every suite importing a
 *    module that touches chalk failed to parse at all.
 * 2. These tests assert on the *text* the CLI prints. Real ANSI escapes
 *    would make every expected string unreadable and dependent on
 *    whether the runner thinks it has a colour terminal.
 *
 * So colour is a no-op here and assertions read as plain strings.
 */
type Styler = ((input: string) => string) & Record<string, unknown>;

function makeStyler(): Styler {
  const styler = ((input: string) => input) as Styler;

  return new Proxy(styler, {
    get(target, property) {
      if (property === 'call' || property === 'apply' || property === 'bind') {
        return Reflect.get(target, property);
      }
      // Every style name, and every chained style, resolves to the same
      // identity function. So `chalk.bold.red(x)` works without anybody
      // listing the vocabulary.
      return makeStyler();
    },
  });
}

const chalk = makeStyler();
export default chalk;
