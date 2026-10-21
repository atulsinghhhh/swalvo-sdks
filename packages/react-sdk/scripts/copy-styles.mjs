// Ships the UI kits' optional default stylesheets as
// `@swalvo/react/chat/styles.css` and `@swalvo/react/video/styles.css`.
//
// Copied rather than bundled: no source file imports it (the components
// are unstyled by default, and importing CSS from library JS would force
// every consumer's bundler to handle CSS just to use a hook). Runs after
// tsup's `clean`, as part of the `onSuccess` hook in tsup.config.ts.
import { copyFileSync, mkdirSync } from 'node:fs';

for (const kit of ['chat', 'video']) {
  mkdirSync(`dist/${kit}`, { recursive: true });
  copyFileSync(`src/${kit}/styles.css`, `dist/${kit}/styles.css`);
  console.log(`[copy-styles] dist/${kit}/styles.css`);
}
