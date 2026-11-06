import api from '@/core/services/api';

// Settings → Security & Privacy.
//
// Planned backend contract — the UI is written against this shape already:
//
//   GET /settings/security                     → { data: SecuritySettings }
//   PUT /settings/security/policies/:key       body { enabled: boolean } → { data: Policy }
//   PUT /settings/security/retention/:key      body { days: number }     → { data: Retention }
//
//   SecuritySettings = { policies: Policy[], privacy: Policy[], retention: Retention[] }
//   Policy    = { key, name, note, enabled: boolean, critical?: boolean }  // critical = confirm before turning off
//   Retention = { key, name, days: number, options: number[] }            // options = allowed values in days
//
// The server must enforce these (password rules, export permissions, deletion
// of data past retention) — the UI only shows and changes the setting.
//
// Until the endpoints exist, USE_MOCK serves the dummy data below and keeps
// changes in localStorage so they survive a reload (but not other browsers or
// sessions). When the backend ships, set USE_MOCK to false (or delete the mock
// branch); nothing in the UI needs to change.
const USE_MOCK = true;

const MOCK_STORAGE_KEY = 'drishyam.mock.securitySettings';
const MOCK_LATENCY_MS = 250;

const RETENTION_OPTIONS = [7, 30, 90, 180, 365];

const MOCK_SETTINGS = {
  policies: [
    { key: 'strong_passwords', name: 'Require strong passwords', note: 'Minimum length, number, and mixed case.', enabled: true, critical: true },
    { key: 'audit_ai_search', name: 'Audit every AI search', note: 'Personnel search and journey map are logged.', enabled: true, critical: true },
    { key: 'restrict_export', name: 'Restrict export access', note: 'Only admins can export reports or evidence.', enabled: true, critical: true },
  ],
  // TODO(product): confirm what privacy mode actually does and replace this note.
  privacy: [
    { key: 'privacy_mode', name: 'Privacy mode', note: 'Extra protection for personal data shown to operators.', enabled: true, critical: true },
  ],
  retention: [
    { key: 'ai_events', name: 'AI event retention', days: 30, options: RETENTION_OPTIONS },
    { key: 'snapshots', name: 'Snapshot retention', days: 30, options: RETENTION_OPTIONS },
    { key: 'audit_logs', name: 'Audit log retention', days: 365, options: RETENTION_OPTIONS },
  ],
};

// Stored overrides: { policies: { [key]: enabled }, retention: { [key]: days } }.
// Storage can be unavailable (private mode, blocked site data); changes then
// last until reload.
function readOverrides() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MOCK_STORAGE_KEY) || '{}');
    return { policies: parsed.policies || {}, retention: parsed.retention || {} };
  } catch {
    return { policies: {}, retention: {} };
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

const allPolicies = () => [...MOCK_SETTINGS.policies, ...MOCK_SETTINGS.privacy];

const mock = {
  get() {
    const { policies, retention } = readOverrides();
    const applyPolicy = (p) => (p.key in policies ? { ...p, enabled: policies[p.key] } : { ...p });
    return delay({
      policies: MOCK_SETTINGS.policies.map(applyPolicy),
      privacy: MOCK_SETTINGS.privacy.map(applyPolicy),
      retention: MOCK_SETTINGS.retention.map((r) => (r.key in retention ? { ...r, days: retention[r.key] } : { ...r })),
    });
  },
  setPolicy(key, enabled) {
    const policy = allPolicies().find((p) => p.key === key);
    if (!policy) return Promise.reject(new Error(`Unknown policy "${key}"`));
    const overrides = readOverrides();
    writeOverrides({ ...overrides, policies: { ...overrides.policies, [key]: enabled } });
    return delay({ ...policy, enabled });
  },
  setRetention(key, days) {
    const item = MOCK_SETTINGS.retention.find((r) => r.key === key);
    if (!item) return Promise.reject(new Error(`Unknown retention setting "${key}"`));
    if (!item.options.includes(days)) return Promise.reject(new Error(`${days} days is not an allowed value`));
    const overrides = readOverrides();
    writeOverrides({ ...overrides, retention: { ...overrides.retention, [key]: days } });
    return delay({ ...item, days });
  },
};

const remote = {
  get:          ()            => api.get('/settings/security').then((r) => r.data.data),
  setPolicy:    (key, enabled) => api.put(`/settings/security/policies/${key}`, { enabled }).then((r) => r.data.data),
  setRetention: (key, days)    => api.put(`/settings/security/retention/${key}`, { days }).then((r) => r.data.data),
};

export const securitySettingsService = USE_MOCK ? mock : remote;

/** "30 days", "1 year" — for retention values and options. */
export function formatRetention(days) {
  if (days % 365 === 0) return days === 365 ? '1 year' : `${days / 365} years`;
  return `${days} days`;
}
