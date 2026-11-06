// Small AI-confidence chip. High ≥90 reads calm/green, ≥80 amber, below that
// slate — a quick "how sure is the model" signal used across the live page.
export default function ConfidenceBadge({ value }) {
  const tone =
    value >= 90 ? 'bg-success-soft text-success-ink ring-success-line'
    : value >= 80 ? 'bg-warning-soft text-warning-ink ring-warning-line'
    : 'bg-surface-muted text-fg-muted ring-line';
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-caption font-bold tabular-nums ring-1 ${tone}`}>
      {value}%
    </span>
  );
}
