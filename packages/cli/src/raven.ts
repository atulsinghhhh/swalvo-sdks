export {};

// The pre-rename `raven` binary. Same CLI; it just points people at `swalvo`.
// stderr only, so `--json` output on stdout stays machine-readable.
process.stderr.write(
  'Note: the `raven` command is deprecated and will be removed; use `swalvo` instead (same commands and options).\n',
);
await import('./index.js');
