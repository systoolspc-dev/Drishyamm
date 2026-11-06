import { AlertTriangle, CheckCircle2, Clock, Video } from 'lucide-react';
import { MetricCard, MetricGrid } from '@/core/ui/metric-card';
import { fmtPercent, gradeDelay } from './health-vocabulary';

/**
 * The four numbers an operator wants before they read a single row: how many
 * cameras there are, how many are fine, how many need them, and whether the
 * system as a whole is keeping up.
 *
 * Built on the product-wide MetricCard so these tiles read exactly like the
 * ones on Home — at `sm`, because on this page the tiles are the preamble and
 * the camera list is the work. The dense size keeps all four numbers on one
 * screen with the first rows of the table.
 */
export function HealthSummary({ total, online, attention, avgDelay, streamingCount }) {
  // Average delay is only meaningful across the cameras actually sending
  // video. Folding the silent ones in as 0 ms would flatter a system in which
  // half the estate is down — the opposite of what this page is for.
  const streaming = streamingCount > 0;
  const delay = gradeDelay(avgDelay, { hasStream: streaming });

  return (
    <MetricGrid cols={4} className="shrink-0">
      <MetricCard
        size="sm"
        icon={Video} tone="info"
        label="Total Cameras" value={total}
        sub={`${streamingCount} streaming`}
      />
      <MetricCard
        size="sm"
        icon={CheckCircle2} tone="success"
        label="Online" value={online}
        sub={fmtPercent(online, total)}
      />
      <MetricCard
        size="sm"
        icon={AlertTriangle} tone={attention > 0 ? 'danger' : 'success'}
        label="Need Attention" value={attention}
        sub={attention > 0 ? fmtPercent(attention, total) : 'All clear'}
        alert={attention > 0}
      />
      <MetricCard
        size="sm"
        icon={Clock} tone={delay.tone}
        label="Average Delay"
        value={streaming ? `${Math.round(avgDelay)} ms` : '—'}
        sub={streaming ? `${delay.label} · across ${streamingCount} streaming` : 'No cameras streaming'}
        alert={delay.tone === 'danger'}
        title="Delay is how far behind live the feed runs. Under 80 ms is smooth, 80-200 ms is noticeable, above 200 ms will stall."
      />
    </MetricGrid>
  );
}

export default HealthSummary;
