'use client';

import { createContext, useContext } from 'react';
import { SwalvoStore } from './store';

export const SwalvoStoreContext = createContext<SwalvoStore | null>(null);

export function useSwalvoStore(): SwalvoStore {
  const store = useContext(SwalvoStoreContext);
  if (!store) {
    throw new Error('@swalvo/react hooks must be used inside a <SwalvoRoom>; see docs/sdk/react.md.');
  }
  return store;
}
