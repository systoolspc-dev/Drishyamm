import { create } from 'zustand';

// The home search box lives in the navbar but filters the dashboard rendered
// below it, so the query has to sit outside both components.
export const useSearchStore = create((set) => ({
  query: '',
  setQuery: (query) => set({ query }),
  clear: () => set({ query: '' }),
}));
