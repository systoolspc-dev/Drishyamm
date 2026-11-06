// Lazy CSS boundary for the AI-analytics subsystem.
//
// WHY THIS FILE EXISTS: both stylesheets used to be imported at the top of
// src/App.jsx, which is the entry module. That hoisted 446 KB of scoped CSS into
// the single global index-*.css, so every operator downloaded the entire
// analytics design system before /login could paint — on routes that never
// mount a `.ai-analytics-scope` element.
//
// Importing them here instead, behind a lazy() boundary, makes Vite emit them as
// a route-level CSS chunk fetched only when an /ai-analytics/* route is entered.
//
// NO FLASH OF UNSTYLED CONTENT: Vite's preload helper inserts the <link> for a
// chunk's CSS and awaits its load event before resolving the module promise, so
// this component cannot render — and therefore the `.ai-analytics-scope` div and
// its children cannot appear — until the stylesheet is applied. The scope div
// must wrap the pages, never mount after them: every rule in analytics.css is
// prefixed with `.ai-analytics-scope`, so an unscoped page is an unstyled page.

// Scoped design system for the AI-analytics modules (tokens + component classes
// confined to .ai-analytics-scope so they never touch the host/admin styles).
import './analytics.css';
// Hand-authored tweaks layered on top of the generated analytics.css (survives regen).
import './ai-analytics-overrides.css';

export default function AnalyticsScope({ children }) {
  return <div className="ai-analytics-scope">{children}</div>;
}
