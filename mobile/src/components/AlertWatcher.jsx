// AlertWatcher — foreground alarm buzz + sound. Watches the shared ai-events
// query; when a NEW event appears (after the first snapshot), it vibrates,
// beeps (alertFx — audible even on iOS silent switch) and shows a toast —
// threats (weapon/fire/aggression) hit harder and toast red. Gated by the
// `buzz` setting. Renders nothing; mounted once in App. Foreground only —
// real push (FCM/APNs) is a later server-side feature.
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listAiEvents } from '../lib/api';
import { useAuth } from '../lib/authStore';
import { useSettings } from '../lib/settingsStore';
import { playAlertFx } from '../lib/alertFx';
import { useAlarm } from '../lib/alarmStore';
import { notify } from './toast';

const THREAT_RE = /weapon|fire|aggression/;
const eventKey = (e) => String(e.id ?? `${e.eventType}-${e.ts}`);

export default function AlertWatcher() {
  const token = useAuth((s) => s.token);
  return token ? <Watcher /> : null;
}

function Watcher() {
  const buzz = useSettings((s) => s.buzz);
  // limit 100 matches Home, Alerts and Live View. All four share the key
  // ['ai-events'], so React Query dedupes them into ONE request — and whichever
  // mounted first decided the limit for everybody. This watcher mounts at app
  // start, so it was silently capping every screen at 20 events. Same key now
  // means same limit, one request, consistent counts.
  const { data: events = [] } = useQuery({
    queryKey: ['ai-events'],
    queryFn: () => listAiEvents({ limit: 100 }),
    refetchInterval: 20_000,
  });

  const seen = useRef(null); // null until the first snapshot lands
  useEffect(() => {
    if (seen.current === null) {
      // first data = baseline; never buzz for history
      if (events.length) seen.current = new Set(events.map(eventKey));
      return;
    }
    const fresh = events.filter((e) => !seen.current.has(eventKey(e)));
    if (!fresh.length) return;
    fresh.forEach((e) => seen.current.add(eventKey(e)));
    if (!buzz) return;

    const top = fresh.find((e) => THREAT_RE.test(String(e.eventType || '').toLowerCase())) || fresh[0];
    const threat = THREAT_RE.test(String(top.eventType || '').toLowerCase());
    const title = String(top.eventType || 'Alert').replace(/_/g, ' ');
    const body = `${top.cameraName ? `Camera: ${top.cameraName}` : 'New alarm'}${fresh.length > 1 ? ` · +${fresh.length - 1} more` : ''}`;
    if (threat) {
      // threats RING until someone hits STOP on the banner (or the 5-min cap)
      useAlarm.getState().ring({ title: `${title} detected`, body, threat: true });
    } else {
      playAlertFx(false);
      notify.info(title.charAt(0).toUpperCase() + title.slice(1), body);
    }
  }, [events, buzz]);

  return null;
}
