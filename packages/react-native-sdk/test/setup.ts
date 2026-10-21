// Node, not jsdom. This package's testable logic is platform glue, and
// jsdom would hand us a `navigator.mediaDevices` that hides the exact
// "globals not registered" case the bootstrap exists to fix.
