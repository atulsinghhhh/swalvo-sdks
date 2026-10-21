import { createRoot } from 'react-dom/client';
import { App } from './App';

// StrictMode is not used here, on purpose: its dev-only double-invoke of
// effects would join, leave, then immediately rejoin the same room on
// every mount: harmless in principle, but confusing in a demo whose
// whole point is to show a clean connection lifecycle. See
// docs/sdk/react.md#strict-mode for how to handle this in a real app.
createRoot(document.getElementById('root')!).render(<App />);
