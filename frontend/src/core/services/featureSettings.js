import api from '@/core/services/api';

// Settings → Feature Controls.
//
// Planned backend contract — the UI is written against this shape already:
//
//   GET /settings/features          → { data: FeatureGroup[] }
//   PUT /settings/features/:key     body { enabled: boolean }  → { data: Feature }
//
//   FeatureGroup = { id: string, title: string, items: Feature[] }
//   Feature      = { key: string, name: string, note: string, enabled: boolean,
//                    critical?: boolean }   // critical = confirm before turning off
//
// Until the endpoints exist, USE_MOCK serves the dummy data below and keeps
// changes in localStorage so they survive a reload (but not other browsers or
// sessions). When the backend ships, set USE_MOCK to false (or delete the mock
// branch); nothing in the UI needs to change.
const USE_MOCK = true;

const MOCK_STORAGE_KEY = 'drishyam.mock.featureSettings';
const MOCK_LATENCY_MS = 250;

const MOCK_GROUPS = [
  {
    id: 'ai-detection',
    title: 'AI Detection',
    items: [
      { key: 'face_recognition', name: 'Face recognition', note: 'Identify enrolled people on live cameras.', enabled: true, critical: true },
      { key: 'unknown_person_alerts', name: 'Unknown person alerts', note: 'Flag people who are not enrolled.', enabled: true },
      { key: 'journey_mapping', name: 'Journey mapping', note: 'Group sightings into movement history.', enabled: true },
      { key: 'watchlist_escalation', name: 'Watchlist escalation', note: 'Send high priority alerts for restricted people.', enabled: true, critical: true },
    ],
  },
  {
    id: 'operations',
    title: 'Operations',
    items: [
      { key: 'stream_health', name: 'Stream health monitoring', note: 'Show delay, bitrate, and camera stability.', enabled: true },
      { key: 'two_way_audio', name: 'Two-way audio', note: 'Enable push-to-talk where hardware supports it.', enabled: false },
      { key: 'auto_reconnect', name: 'Auto reconnect', note: 'Recover stalled streams automatically.', enabled: true },
      { key: 'retention_cleanup', name: 'Retention cleanup', note: 'Delete old AI events based on policy.', enabled: true },
    ],
  },
];

// Stored overrides are just { [key]: enabled }; storage can be unavailable
// (private mode, blocked site data), in which case changes last until reload.
function readOverrides() {
  try {
    return JSON.parse(localStorage.getItem(MOCK_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeOverrides(overrides) {
  try {
    localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* storage unavailable — keep going */
  }
}

const delay = (value) => new Promise((resolve) => setTimeout(() => resolve(value), MOCK_LATENCY_MS));

const mock = {
  list() {
    const overrides = readOverrides();
    return delay(
      MOCK_GROUPS.map((group) => ({
        ...group,
        items: group.items.map((item) =>
          item.key in overrides ? { ...item, enabled: overrides[item.key] } : { ...item },
        ),
      })),
    );
  },
  update(key, enabled) {
    const item = MOCK_GROUPS.flatMap((g) => g.items).find((i) => i.key === key);
    if (!item) return Promise.reject(new Error(`Unknown feature "${key}"`));
    writeOverrides({ ...readOverrides(), [key]: enabled });
    return delay({ ...item, enabled });
  },
};

const remote = {
  list:   ()             => api.get('/settings/features').then((r) => r.data.data),
  update: (key, enabled) => api.put(`/settings/features/${key}`, { enabled }).then((r) => r.data.data),
};

export const featureSettingsService = USE_MOCK ? mock : remote;
