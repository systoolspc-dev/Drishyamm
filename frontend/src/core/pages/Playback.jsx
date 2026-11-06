import { useSearchParams } from 'react-router-dom';
import {
  Film,
  Grid3x3,
  PlaySquare,
  Server,
} from 'lucide-react';
import {
  OperationsPage,
  PageContent,
  PageHeader,
  PageTabs,
} from '@/core/layout/OperationsPage';
import CloudPlayback from '@/core/pages/CloudPlayback';
import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';
import Timelapse from '@/core/pages/Timelapse';
import NvrPlayback from '@/core/pages/NvrPlayback';

const TABS = [
  {
    id: 'nvr',
    label: 'Site recorder',
    Icon: Server,
    feature: 'playback',
    description: 'Replay footage saved on your site’s recorder — pick a camera and a time.',
  },
  {
    id: 'recordings',
    label: 'Cloud',
    Icon: Grid3x3,
    feature: 'cloud_recordings',
    description: 'Replay clips this system recorded to cloud storage, with their events and bookmarks.',
  },
  {
    id: 'timelapse',
    label: 'Timelapse',
    Icon: Film,
    feature: 'playback',
    description: 'Find longer ranges and compact evidence for review or download.',
  },
];

export default function Playback() {
  const [params, setParams] = useSearchParams();
  // Each tab is its own account switch: Recordings (site recorder + timelapse)
  // and Cloud recordings. The route needs one of them (entitlements.js).
  const user = useAuthStore((s) => s.user);
  const { has } = makeEntitlement(user);
  const tabs = TABS.filter((t) => has(t.feature));
  const active = normalizeTab(params.get('tab'), tabs);

  const setActive = (tabId) => {
    const next = new URLSearchParams(params);
    if (tabId === tabs[0]?.id) next.delete('tab');
    else next.set('tab', tabId);
    setParams(next, { replace: true });
  };

  return (
    <OperationsPage>
      <PageHeader
        icon={PlaySquare}
        title="Recordings"
        description="Search and review past footage from your cameras"
        actions={tabs.length > 1 ? <PageTabs tabs={tabs} active={active} onChange={setActive} /> : null}
      />

      <PageContent>
        {active === 'timelapse' ? <Timelapse /> : null}
        {active === 'nvr' ? <NvrPlayback /> : null}
        {active === 'recordings' ? <CloudPlayback /> : null}
      </PageContent>
    </OperationsPage>
  );
}

// Old links still say ?tab=timeline; they carry a camera and a moment, so the
// site recorder serves them. A tab the account does not have falls back to the
// first one it does.
function normalizeTab(value, tabs) {
  const ids = tabs.map((t) => t.id);
  const want = value === 'recordings' || value === 'timelapse' ? value : 'nvr';
  return ids.includes(want) ? want : ids[0];
}
