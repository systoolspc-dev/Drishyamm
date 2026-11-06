// Recharts theme tokens. Recharts writes these straight onto SVG presentation
// attributes, which the browser treats as author-level CSS — so a var() here
// resolves and re-resolves when the theme flips, which a baked hex never would.
//
// Promoted out of `modules/employee-productivity/campus/components` so any
// module can draw a chart that matches the rest of the app. The campus path
// re-exports these, so existing imports keep working.
export const AXIS = { fontSize: 10, fill: 'var(--text-subtle)' };
export const GRID = { stroke: 'var(--line)', vertical: false };
export const TIP = {
  contentStyle: {
    borderRadius: 10,
    border: '1px solid var(--line)',
    background: 'var(--surface)',
    color: 'var(--text-primary)',
    fontSize: 11,
    boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
  },
  itemStyle: { color: 'var(--text-secondary)' },
  labelStyle: { color: 'var(--text-primary)' },
};
