import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Building2,
  Camera,
  Cctv,
  Brain,
  Network,
} from 'lucide-react';
import {
  OperationsPage,
  PageContent,
  PageHeader,
  PageTabStrip,
} from '@/core/layout/OperationsPage';
import { useCameras, useGroups } from '@/core/hooks/useQueries';
import { siteService } from '@/core/services/site';
import { aiService } from '@/core/services/ai';
import api from '@/core/services/api';
import Sites from '@/core/pages/Sites';
import CameraGroups from '@/core/pages/CameraGroups';
import Cameras from '@/core/pages/Cameras';
import AiDetectionSetup from '@/core/pages/AiDetectionSetup';

/**
 * Camera Setup — one page, four sections.
 *
 * ONE title. The tab strip under it names the section, so Sites, Devices,
 * Cameras and AI Detection render no heading of their own: each opens
 * straight on its toolbar row (search + filters, then Refresh + the primary
 * action). Before this, the page header AND every tab drew an icon, a title
 * and a paragraph, so an operator read two headers and the same facts twice
 * before reaching any content.
 *
 * The header carries a plain one-line description and no info icon — the
 * sentence already says what the page is for.
 */
export default function CameraSetup() {
  const [params, setParams] = useSearchParams();
  const active = normalizeTab(params.get('tab'));
  const summary = useSetupSummary();

  // Switch tab, optionally with tab-specific filters (?status=offline from
  // an attention link). Filters never carry over from one tab to the next.
  const setActive = (tabId, extra) => {
    const next = new URLSearchParams();
    if (tabId !== 'sites') next.set('tab', tabId);
    Object.entries(extra || {}).forEach(([key, value]) => {
      if (value != null && value !== '') next.set(key, String(value));
    });
    setParams(next, { replace: true });
  };

  // Counts on the tabs: the size of each section is visible before it is
  // opened. A count is omitted (no pill) until its data has loaded.
  const tabs = useMemo(() => ([
    { id: 'sites',        label: 'Sites',        Icon: Building2, count: summary.sites },
    { id: 'devices',      label: 'Devices',      Icon: Network,   count: summary.devices },
    { id: 'cameras',      label: 'Cameras',      Icon: Camera,    count: summary.cameras },
    { id: 'ai-detection', label: 'AI Detection', Icon: Brain,     count: summary.aiOn },
  ]), [summary]);

  return (
    <OperationsPage>
      <PageHeader
        icon={Cctv}
        title="Add cameras"
        description="Manage sites, devices, cameras and AI detection."
        actions={<LicenceUsage />}
        context={<PageTabStrip tabs={tabs} active={active} onChange={setActive} />}
      />

      <PageContent scroll>
        {active === 'sites' ? <Sites summary={summary} onNavigate={setActive} /> : null}
        {active === 'devices' ? <CameraGroups onNavigate={setActive} /> : null}
        {active === 'cameras' ? <Cameras onNavigate={setActive} /> : null}
        {active === 'ai-detection' ? <AiDetectionSetup onNavigate={setActive} /> : null}
      </PageContent>
    </OperationsPage>
  );
}

/**
 * Account-wide counts for the tab strip and the metric rows. Cameras and
 * devices come from the same react-query caches the tabs use, so opening a
 * tab costs no extra request; sites and the AI summary are small lists the
 * tabs keep in step via setQueryData after their own loads.
 *
 * These are ACCOUNT counts, not per-site ones: a device or camera that is not
 * linked to any site still counts here, which is what "is this account
 * empty?" has to mean.
 */
function useSetupSummary() {
  const { data: cameras } = useCameras();
  const { data: groups }  = useGroups();
  const { data: sites } = useQuery({
    queryKey: ['sites'],
    queryFn: () => siteService.list().then((r) => r.data || []),
    staleTime: 30_000,
  });
  const { data: ai } = useQuery({
    queryKey: ['ai-camera-settings-summary'],
    queryFn: () => aiService.listCameraAiSettings().then((p) => p.summary || {}),
    staleTime: 30_000,
    retry: false,
  });

  return useMemo(() => ({
    sites:         sites ? sites.length : undefined,
    devices:       groups ? groups.length : undefined,
    cameras:       cameras ? cameras.length : undefined,
    camerasOnline: cameras ? cameras.filter((c) => c.mode === 'start').length : undefined,
    aiOn:          ai ? (ai.enabled || 0) : undefined,
  }), [sites, groups, cameras, ai]);
}

/**
 * Camera licences used vs allowed for this account (set by the admin
 * console). Shown before anyone fills in an Add Device form the backend will
 * refuse. Nothing renders for an unlimited account — a "∞" pill is noise.
 * Amber at the last licence, red when none are left.
 */
function LicenceUsage() {
  const { data } = useQuery({
    queryKey: ['licence-usage'],
    queryFn: () => api.get('/subscription/usage').then((r) => r.data?.data || null),
    staleTime: 30_000,
    retry: false,
  });
  const cams = data?.cameras;
  if (!cams || cams.limit === null || cams.limit === undefined) return null;
  const tone = cams.remaining === 0
    ? 'border-danger-line bg-danger-soft text-danger-ink'
    : cams.remaining <= 1
      ? 'border-warning-line bg-warning-soft text-warning-ink'
      : 'border-border bg-surface text-fg-muted';
  const ai = (data.ai || []).filter((l) => l.limit !== null && l.limit !== undefined);
  const title = ai.length
    ? ai.map((l) => `${l.label}: ${l.used} of ${l.limit} cameras`).join('\n')
    : undefined;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${tone}`}
      title={title}
    >
      Camera licences
      <span className="font-mono tabular-nums">{cams.used} / {cams.limit}</span>
      <span>· {cams.remaining} left</span>
    </span>
  );
}

function normalizeTab(value) {
  if (value === 'devices' || value === 'cameras' || value === 'ai-detection') return value;
  return 'sites';
}
