import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Building2,
  Circle,
  CheckCircle2,
  ChevronRight,
  Coins,
  Cpu,
  Database,
  FileText,
  Loader2,
  Download,
  Gauge,
  KeyRound,
  Lock,
  Mail,
  Radio,
  RefreshCw,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  UsersRound,
  Video,
  WalletCards,
} from 'lucide-react';
import { useGroups } from '@/core/hooks/useQueries';
import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';
import { licenseService } from '@/core/services/license';
import ManageUsersSection from './settings/ManageUsersSection';
import AlertRecipients from '@/modules/alerts/AlertRecipients';
import { Button } from '@/core/ui/button';
import { Badge } from '@/core/ui/badge';
import { MetricCard } from '@/core/ui/metric-card';
import { SectionHeading, CardHeading } from '@/core/ui/typography';
import { OperationsPage, PageHeader, PageTabs } from '@/core/layout/OperationsPage';
import { toneClass } from '@/core/ui/tone';
import { HeaderInfo } from '@/core/ui/header-info';
import { ConfirmDialog } from '@/core/ui/confirm-dialog';
import { LoadingState, ErrorState } from '@/core/ui/states';
import { toast } from '@/core/store/toastStore';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { featureSettingsService } from '@/core/services/featureSettings';
import { securitySettingsService, formatRetention } from '@/core/services/securitySettings';

import { AI_BASE } from '@/core/config/endpoints';
import { aiService } from '@/core/services/ai';
const POLL_MS = 4000;

const VMS_CAMERA_MONTH_INR = 75;
const STORAGE_SOFTWARE_MONTH_INR = 15;
const AI_CAMERA_BASE_MONTH_INR = 150;
const AI_TOKEN_INR = 0.000075;
const AI_RATE_PER_LAKH_INR = AI_TOKEN_INR * 100000; // ₹7.50 per lakh AI checks
const GPU_NODE_MONTH_INR = 50000;
const GPU_TOKEN_CAPACITY_PER_SEC = 300;
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;

const SECTION_GROUPS = [
  {
    label: 'Workspace',
    items: [
      { id: 'overview', label: 'Overview', desc: 'Platform status at a glance', Icon: SettingsIcon },
      { id: 'organization', label: 'Organization', desc: 'Tenant, plan & contacts', Icon: Building2 },
    ],
  },
  {
    label: 'Operations',
    items: [
      { id: 'features', label: 'Feature Controls', desc: 'Module-level toggles', Icon: SlidersHorizontal },
      { id: 'reports', label: 'Reports', desc: 'Scheduled summaries', Icon: FileText },
      { id: 'notifications', label: 'Alert Emails', desc: 'Emails that receive alerts', Icon: Mail, feature: 'email_alerts' },
    ],
  },
  {
    label: 'Governance',
    items: [
      { id: 'security', label: 'Security & Privacy', desc: 'Access policy & retention', Icon: ShieldCheck },
      { id: 'users', label: 'Manage Users', desc: 'Roles, scope & access', Icon: UsersRound, adminOnly: true, feature: 'user_management' },
    ],
  },
];

const SECTIONS = SECTION_GROUPS.flatMap((group) => group.items);

// Sections made only of cards, rendered without the outer white panel.
const BARE_SECTIONS = new Set(['overview', 'organization', 'features', 'notifications', 'security']);

// TODO(backend): placeholder organization data until the tenant API exists.
// Real license values from useMyLicense() still take precedence where present.
const ORG_PLACEHOLDER = {
  name: 'Drishyam',
  camerasUsed: 24,
  cameraQuota: 28,
  renews: '31 Mar 2027',
  daysLeft: 186,
  timezone: 'Asia/Kolkata (GMT+5:30)',
  contact: 'ops@drishyam.ai',
  integrations: [
    { name: 'Email alerts', Icon: Mail, connected: true, section: 'notifications' },
    { name: 'Storage backend', Icon: Database, connected: true },
    { name: 'AI engine', Icon: Cpu, connected: true },
    { name: 'SMS gateway', Icon: Bell, connected: false },
  ],
};

const REPORTS = [
  { title: 'Daily security summary', schedule: 'Every day, 8:00 AM', audience: 'Security admin', enabled: true },
  { title: 'AI usage and billing', schedule: 'Monthly', audience: 'Management', enabled: true },
  { title: 'Camera health report', schedule: 'Every Monday', audience: 'IT team', enabled: true },
  { title: 'Watchlist incident report', schedule: 'On incident', audience: 'Security head', enabled: false },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fmtNumber(value, digits = 0) {
  const n = Number(value) || 0;
  return n.toLocaleString('en-IN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function fmtInr(value) {
  return `₹${Math.round(Number(value) || 0).toLocaleString('en-IN')}`;
}

// AI checks (= video frames analysed). Indian formatting: thousands → lakh → crore.
function fmtChecks(value) {
  const n = Number(value) || 0;
  if (n >= 10_000_000) return `${fmtNumber(n / 10_000_000, 2)} Cr`;
  if (n >= 100_000) return `${fmtNumber(n / 100_000, 2)} L`;
  if (n >= 1_000) return n.toLocaleString('en-IN');
  return fmtNumber(n);
}

function cameraTokenRate(camera) {
  return camera.running ? Number(camera.fps || 0) : 0;
}

function cameraMonthlyTokens(camera) {
  return cameraTokenRate(camera) * SECONDS_PER_MONTH;
}

function cameraAiPrice(camera) {
  if (!camera.running) return 0;
  return AI_CAMERA_BASE_MONTH_INR + cameraMonthlyTokens(camera) * AI_TOKEN_INR;
}

function cameraLoad(camera) {
  const fpsLoad = clamp((cameraTokenRate(camera) / 5) * 55, 0, 55);
  const faceLoad = clamp(Number(camera.persons || 0) * 3, 0, 30);
  const activeLoad = camera.running ? 10 : 0;
  return Math.round(clamp(fpsLoad + faceLoad + activeLoad, 0, 100));
}

function loadColor(load) {
  if (load >= 75) return '#ef4444';
  if (load >= 45) return '#f59e0b';
  return '#10b981';
}

export default function Settings() {
  const user = useAuthStore((state) => state.user);
  // MANAGE_USERS is for admins and owners (legacy 'user' = full access). Gates the nav item + section.
  const isAdmin = ['admin', 'owner', 'user'].includes(user?.role);
  // Account switches (admin console): Email alerts and Users & roles hide
  // their sections; the backend refuses their APIs too.
  const { has } = makeEntitlement(user);
  const sectionOn = (it) => (!it.adminOnly || isAdmin) && (!it.feature || has(it.feature));
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') || 'overview';
  const known = SECTIONS.find((it) => it.id === requested);
  const active = known && !sectionOn(known) ? 'overview' : requested;
  const setActive = (id) => setParams(id === 'overview' ? {} : { tab: id });

  return (
    // Same frame and header as Reports, Live View and the other Operations pages.
    <OperationsPage>
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        description="Manage platform controls, AI usage, reports, security, and organization policy from one unified console."
        // No page-level Save: every section saves each change as it is made.
        actions={
          <span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-success-line bg-success-soft px-2.5 text-small font-semibold text-success-ink">
            <CheckCircle2 className="h-3.5 w-3.5" />
            System ready
          </span>
        }
      />

        {/* Mobile-first. Below `lg` this is ONE scrolling column: the nav card
            sits above the open section, both at their natural height, and this
            container is the scroll port — so the page scrolls as a page.
            It was this same two-pane grid at every width, which on a phone gave
            the nav rail and the section an independent ~150px scroll pane each,
            stacked inside the fixed-height Operations frame.
            From `lg` the grid returns and each pane scrolls itself again.

            `w-full max-w-full` is the fluid contract: the shell takes the width
            the Operations frame gives it and never asks for more. There is no
            horizontal overflow escape hatch here on purpose — `overflow-x-hidden`
            below `lg` hides a too-wide child, it does not make it fit, and that
            is precisely how a card came to look like its right-hand padding had
            been cut off. The cards are clamped at the source instead
            (`settings-shell` in index.css), so there is nothing to hide. */}
        <div className="settings-shell settings-type flex w-full min-h-0 max-w-full flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden sm:gap-5 lg:grid lg:grid-cols-[minmax(0,296px)_minmax(0,1fr)] lg:overflow-visible">
          {/* Section nav — golden-ratio split (296 : 1fr ≈ 1 : φ on a 1200px canvas).
              `minmax(0,296px)` rather than a bare `296px`: the track still sizes
              to 296px wherever there is room — a non-flexible track takes its
              growth limit before `1fr` divides what is left — so the rail looks
              the same as it did. The difference is that a bare `296px` is a
              floor as well as a ceiling: it holds that width even when the grid
              has less to give and the overflow goes to the section pane beside
              it. Now the rail yields first, which is the right order — the rail
              is a list of short labels and the pane holds the content. */}
          <aside className="flex w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm lg:min-h-0">
            <div className="shrink-0 border-b border-line-subtle px-3 py-3 sm:px-4">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand/15 text-small font-semibold text-brand">
                  {initials(user?.name || user?.email || 'Admin')}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-body font-semibold text-fg lg:truncate">
                    {user?.name || 'Admin User'}
                  </p>
                  {/* An email has no spaces to wrap at, so it breaks mid-string
                      rather than widening the card past the viewport; on the
                      fixed-width rail from `lg` it truncates as before. */}
                  <p className="mt-0.5 break-all text-caption text-fg-muted lg:truncate">
                    {user?.email || 'admin@drishyam.local'}
                  </p>
                </div>
              </div>
            </div>
            {/* Full list on a phone — no inner scroll port, so the nav never
                becomes a short pane you have to scroll to find a section. */}
            <nav className="scroll-thin px-2 py-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {SECTION_GROUPS.map((group, gIdx) => (
                <div key={group.label} className={gIdx === 0 ? '' : 'mt-3'}>
                  <p className="px-3 pb-1 pt-1 text-micro uppercase text-fg-subtle">
                    {group.label}
                  </p>
                  <div className="space-y-px">
                    {group.items.filter(sectionOn).map(({ id, label, desc, Icon }) => {
                      const isActive = active === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setActive(id)}
                          aria-current={isActive ? 'page' : undefined}
                          className={`group relative flex w-full items-start gap-3 rounded-lg px-2.5 py-1.5 text-left transition lg:items-center ${
                            isActive
                              ? 'bg-brand-soft text-fg'
                              : 'text-fg-secondary hover:bg-surface-sunken hover:text-fg'
                          }`}
                        >
                          {isActive && (
                            <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-brand" aria-hidden />
                          )}
                          <span
                            className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border transition ${
                              isActive
                                ? 'border-brand-line bg-surface text-brand'
                                : 'border-transparent bg-surface-muted text-fg-muted group-hover:bg-line/60'
                            }`}
                          >
                            <Icon className="h-4 w-4" strokeWidth={isActive ? 2.25 : 1.85} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-body font-semibold">{label}</span>
                            {/* Wraps to a second line on a phone, where there is
                                width to spare; truncated only on the fixed
                                296px rail, where it cannot wrap cleanly. */}
                            <span className="block break-words text-caption text-fg-subtle lg:truncate">{desc}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </aside>

          {/* Card-only sections sit straight on the page background; the form
              sections keep their white panel. */}
          <main
            className={`settings-pane w-full min-w-0 lg:min-h-0 lg:overflow-hidden ${
              BARE_SECTIONS.has(active) ? '' : 'rounded-xl border border-line bg-surface shadow-sm'
            }`}
          >
            {/* The inner scroll port belongs to the two-pane layout; below `lg`
                the section grows to its content and the container scrolls it.
                Padding steps down on a phone — 20px inside a card that already
                sits in a 16px page gutter left the content on a narrow ribbon. */}
            <div className={`scroll-thin lg:h-full lg:min-h-0 lg:overflow-y-auto ${BARE_SECTIONS.has(active) ? 'p-0.5' : 'p-3 sm:p-5 lg:p-6'}`}>
              {active === 'features' ? <FeaturesSection /> : null}
              {active === 'reports' ? <ReportsSection /> : null}
              {active === 'security' ? <SecuritySection /> : null}
              {active === 'organization' ? <OrganizationSection user={user} onOpenSection={setActive} /> : null}
              {active === 'users' && isAdmin ? <ManageUsersSection /> : null}
              {active === 'overview' ? <OverviewSection user={user} onOpenSection={setActive} /> : null}
              {active === 'notifications' ? <AlertEmailsSection /> : null}
            </div>
          </main>
        </div>
    </OperationsPage>
  );
}

const SETUP_STEPS = [
  { title: 'Enable AI usage alerts', note: 'Warn management before monthly token usage crosses budget.', done: true },
  { title: 'Review report recipients', note: 'Add security head and IT admin to scheduled reports.', done: true },
  { title: 'Map camera locations', note: 'Journey Map is clearer when cameras have readable area names.', done: false, href: '/camera-setup?tab=cameras' },
  { title: 'Set retention policy', note: 'Define how long AI events, snapshots, and audit logs are kept.', done: true },
];

function OverviewSection({ user, onOpenSection }) {
  const navigate = useNavigate();
  const doneCount = SETUP_STEPS.filter((s) => s.done).length;
  // Same query keys as the Feature Controls and Security sections, so the
  // cards share their cache and update the moment a switch is flipped there.
  const featuresQ = useQuery({ queryKey: FEATURES_QUERY_KEY, queryFn: featureSettingsService.list });
  const securityQ = useQuery({ queryKey: SECURITY_QUERY_KEY, queryFn: securitySettingsService.get });

  const countOn = (items) => (items ? `${items.filter((i) => i.enabled).length} / ${items.length}` : '—');
  const aiFeatures = featuresQ.data?.flatMap((g) => g.items);
  const policies = securityQ.data?.policies;

  return (
    <section className="space-y-4">
      <div className="settings-cards gap-4">
        <OverviewCard Icon={Video} tone="brand" label="Camera Estate" value="Active" sub="Live, AI Feed, health" onClick={() => navigate('/camera-setup?tab=cameras')} />
        <OverviewCard Icon={Sparkles} tone="success" label="AI Detection" value={countOn(aiFeatures)} sub="Features switched on" onClick={() => onOpenSection('features')} />
        <OverviewCard Icon={FileText} tone="ai" label="Reports" value="Live" sub="Event summaries, CSV export" onClick={() => onOpenSection('reports')} />
        <OverviewCard Icon={ShieldCheck} tone="info" label="Security" value={countOn(policies)} sub="Access policies on" onClick={() => onOpenSection('security')} />
      </div>
      {/* Golden-ratio split: 1fr (≈61.8%) : 360px (≈38.2% of an 944px row),
          taken once the PANE is wide enough for it rather than once the window is. */}
      <div className="settings-aside gap-4">
        <Panel
          title="Recommended Setup"
          aside={
            <span className="shrink-0 text-small font-medium text-fg-subtle">
              {doneCount} of {SETUP_STEPS.length} complete
            </span>
          }
        >
          {SETUP_STEPS.map((step) => (
            <ChecklistItem
              key={step.title}
              title={step.title}
              note={step.note}
              done={step.done}
              onSetup={step.href ? () => navigate(step.href) : undefined}
            />
          ))}
        </Panel>
        <AccountSnapshotPanel user={user} onOpenSection={onOpenSection} />
      </div>
    </section>
  );
}

// Settings summary tile: the value leads, the title and icon only label it.
// Each card gets its own soft semantic tone so the row is not four orange icons.
function OverviewCard({ Icon, tone = 'neutral', label, value, sub, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col rounded-xl border border-line bg-surface p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <div className="flex items-start justify-between">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${toneClass(tone, 'soft')}`}>
          <Icon className="h-4 w-4" strokeWidth={1.85} />
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-fg-subtle opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100" />
      </div>
      <p className="mt-4 text-micro uppercase text-fg-subtle">{label}</p>
      <p className="mt-1 text-section text-fg">{value}</p>
      <p className="mt-1 text-small leading-normal text-fg-muted">{sub}</p>
    </button>
  );
}

function AccountSnapshotPanel({ user, onOpenSection }) {
  const { license, loading: licenseLoading } = useMyLicense();
  const planLabel = license
    ? `${LICENSE_TERM_LABELS[license.term] || license.term}`
    : (user?.subscription?.plan?.name || 'Enterprise');
  const statusMeta = license ? (LICENSE_STATUS_META[license.status] || LICENSE_STATUS_META.draft) : null;
  return (
    <Panel title="Account Snapshot">
      <InfoLine label="User" value={user?.name || 'Admin User'} />
      <InfoLine label="Role" value={title(user?.role || 'admin')} />
      <InfoLine label="License" value={licenseLoading ? 'Loading…' : planLabel} />
      <InfoLine
        label="Status"
        value={
          statusMeta ? (
            <Badge variant={statusMeta.tone} className="gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${toneClass(statusMeta.tone, 'dot')}`} />
              {statusMeta.label}
            </Badge>
          ) : 'Active'
        }
      />
      <InfoLine
        label="Renews"
        value={
          license?.endDate && license.daysRemaining != null
            ? license.daysRemaining >= 0
              ? `${license.endDate} (${license.daysRemaining}d left)`
              : `${license.endDate} (expired)`
            : `${ORG_PLACEHOLDER.renews} (${ORG_PLACEHOLDER.daysLeft}d left)`
        }
      />
      {license && license.mrr > 0 && (
        <InfoLine label="Monthly cost" value={fmtInr(license.mrr)} strong />
      )}
      <button
        type="button"
        onClick={() => onOpenSection('organization')}
        className="mt-3 inline-flex items-center gap-0.5 rounded-md text-small font-semibold text-brand-ink transition hover:text-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        View organization
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </Panel>
  );
}

function UsageSection() {
  const { rows, totals, error, refreshing, fetchStatus, lastUpdated } = useComputeUsage();
  const { license, loading: licenseLoading, error: licenseError } = useMyLicense();
  const detecting = totals.activeAi > 0;

  const vmsBill = totals.totalCameras * VMS_CAMERA_MONTH_INR;
  const storageBill = totals.totalCameras * STORAGE_SOFTWARE_MONTH_INR;
  const aiBaseBill = totals.activeAi * AI_CAMERA_BASE_MONTH_INR;
  const aiUsageBill = Math.max(0, totals.aiMonthly - aiBaseBill);
  const monthlyChecks = totals.monthlyAiTokens;
  const sessionChecks = totals.tokensThisSession;

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex-1">
          <SectionHeader
            Icon={Cpu}
            title="Billing & Compute"
            subtitle="Your monthly bill in rupees, per-camera AI usage, and GPU headroom — refreshed live."
          />
        </div>
        <div className="flex flex-wrap gap-2 lg:pb-1">
          <span className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-caption font-semibold tracking-[-0.005em] ${
            detecting ? 'border-success-line bg-success-soft text-success-ink' : 'border-line bg-surface text-fg-muted'
          }`}>
            <Radio className="h-3.5 w-3.5" />
            {detecting ? `${totals.activeAi} AI camera${totals.activeAi === 1 ? '' : 's'} live` : 'No AI cameras running'}
          </span>
          <button
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-caption font-semibold tracking-[-0.005em] text-fg-secondary transition hover:bg-surface-sunken"
            onClick={fetchStatus}
            type="button"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger-line bg-danger-soft px-3.5 py-2.5 text-small font-semibold text-danger-ink">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      {/* License-aware hero — falls back to legacy estimate when no license */}
      {licenseLoading ? (
        <div className="rounded-xl border border-line bg-surface p-4 sm:p-5">
          <div className="h-3 w-32 animate-pulse rounded bg-surface-muted" />
          <div className="mt-3 h-8 w-48 animate-pulse rounded bg-surface-muted" />
          <div className="mt-2 h-3 w-64 animate-pulse rounded bg-surface-muted" />
        </div>
      ) : licenseError ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning-line bg-warning-soft px-3.5 py-2.5 text-small font-semibold text-warning-ink">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Couldn't load your license: {licenseError}
        </div>
      ) : license ? (
        <LicenseHero license={license} />
      ) : (
        <div className="settings-split gap-4">
          <article className="flex flex-col rounded-xl border border-line bg-surface p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-micro font-semibold uppercase tracking-[0.14em] text-fg-subtle">
                  Estimated monthly bill
                </p>
                <p className="mt-2 text-display leading-none tabular-nums text-fg">
                  {fmtInr(totals.customerMonthly)}
                </p>
                <p className="mt-2 text-small font-medium text-fg-muted">
                  {totals.totalCameras} camera{totals.totalCameras === 1 ? '' : 's'}
                  <span className="mx-1.5 text-fg-disabled">·</span>
                  {totals.activeAi} on AI
                  <span className="mx-1.5 text-fg-disabled">·</span>
                  {totals.gpuNodes || 0} GPU node{totals.gpuNodes === 1 ? '' : 's'}
                </p>
                <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-micro font-semibold uppercase tracking-[0.06em] text-warning-ink">
                  <AlertTriangle className="h-3 w-3" />
                  Legacy plan — contact admin for an enterprise license
                </p>
              </div>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand-ink">
                <WalletCards className="h-5 w-5" strokeWidth={2} />
              </span>
            </div>

            <div className="mt-5 space-y-2.5">
              <BillRow label="VMS subscription"  detail={`${totals.totalCameras} cameras × ₹${VMS_CAMERA_MONTH_INR}/month`} value={vmsBill} />
              <BillRow label="Storage software"  detail={`${totals.totalCameras} cameras × ₹${STORAGE_SOFTWARE_MONTH_INR}/month`} value={storageBill} />
              <BillRow label="AI base fee"       detail={`${totals.activeAi} AI camera${totals.activeAi === 1 ? '' : 's'} × ₹${AI_CAMERA_BASE_MONTH_INR}/month`} value={aiBaseBill} />
              <BillRow label="AI usage"          detail={`${fmtChecks(monthlyChecks)} checks × ₹${AI_RATE_PER_LAKH_INR.toFixed(2)} per lakh`} value={aiUsageBill} />
              <div className="mt-1 flex items-baseline justify-between border-t border-line-subtle pt-3">
                <span className="text-body font-semibold tracking-[-0.005em] text-fg">Estimated total</span>
                <span className="text-metric-sm font-bold tabular-nums tracking-[-0.018em] text-fg">{fmtInr(totals.customerMonthly)}</span>
              </div>
            </div>
          </article>

          <article className="flex flex-col rounded-xl border border-line bg-surface p-4 sm:p-5">
            <p className="text-micro font-semibold uppercase tracking-[0.14em] text-fg-subtle">Pricing model</p>
            <p className="mt-2 text-body font-semibold tracking-[-0.005em] text-fg">How your bill is calculated</p>
            <div className="mt-3.5">
              <PriceRow Icon={Video}    label="VMS · per camera"             value="₹75"   suffix="/mo" />
              <PriceRow Icon={Database} label="Storage software · per camera" value="₹15"  suffix="/mo" />
              <PriceRow Icon={Sparkles} label="AI base · per AI camera"       value="₹150" suffix="/mo" />
              <PriceRow Icon={Cpu}      label="AI usage · per lakh checks"    value="₹7.50" suffix="" />
            </div>
            <p className="mt-4 rounded-lg bg-surface-sunken px-3 py-2.5 text-caption leading-[1.55] text-fg-secondary">
              <span className="font-semibold text-fg">1 AI check</span> = 1 video frame analysed by AI detection.
              Recording-only cameras pay just the VMS + storage fee.
            </p>
          </article>
        </div>
      )}

      {/* Live KPI strip */}
      <div className="settings-tiles gap-3">
        <Kpi Icon={Video} label="Total cameras" value={fmtNumber(totals.totalCameras)} note="Across all sites" accent="#3b82f6" />
        <Kpi Icon={Sparkles} label="AI cameras live" value={`${totals.activeAi} / ${totals.totalCameras}`} note="Currently analysing" accent="#10b981" />
        <Kpi Icon={Coins} label="AI checks today" value={fmtChecks(sessionChecks)} note="In this session" accent="#F7983A" />
        <Kpi Icon={Gauge} label="Live throughput" value={`${fmtNumber(totals.tokenPerSec, 1)} f/s`} note={`${fmtChecks(monthlyChecks)} projected/mo`} accent="#8b5cf6" />
        <Kpi Icon={Server} label="GPU capacity" value={`${totals.capacityUsed}%`} note={`${totals.gpuNodes || 0} RTX PRO 5000 node${totals.gpuNodes === 1 ? '' : 's'}`} accent={loadColor(totals.capacityUsed)} />
      </div>

      {/* Per-camera table */}
      <Panel
        title="Per-camera AI usage"
        subtitle="Live AI cameras consume usage. Recording-only cameras only pay the VMS + storage fee."
        noPadding
      >
        {rows.length === 0 ? (
          <div className="p-4">
            <EmptyState Icon={Video} title="No cameras yet" note="Provision cameras under Camera Setup to see usage." />
          </div>
        ) : (
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 z-10 bg-surface shadow-[inset_0_-1px_0_0_rgb(241_245_249)]">
                <tr className="text-micro font-semibold uppercase tracking-[0.12em] text-fg-subtle">
                  <th className="px-4 py-2.5">Camera</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5 text-right">Throughput</th>
                  <th className="px-3 py-2.5 text-right">Today's checks</th>
                  <th className="px-3 py-2.5 text-right">Monthly bill</th>
                  <th className="px-4 py-2.5 text-right">Load</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <CameraTableRow item={row} key={row.monitorId || row.name} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 ? (
          <div className="border-t border-line-subtle px-4 py-2 text-micro font-medium text-fg-subtle">
            {rows.length} camera{rows.length === 1 ? '' : 's'} · scroll for more
          </div>
        ) : null}
      </Panel>

      {/* Internal admin view */}
      <Panel
        title="Internal compute view"
        subtitle={`Admin only · GPU cost vs revenue · last updated ${lastUpdated ? lastUpdated.toLocaleTimeString() : '--'}`}
      >
        <div className="settings-tiles gap-3">
          <InternalStat label="Customer monthly bill" value={fmtInr(totals.customerMonthly)} />
          <InternalStat label="GPU node cost" value={fmtInr(totals.gpuCost)} />
          <InternalStat
            label="Estimated gross margin"
            value={fmtInr(totals.customerMonthly - totals.gpuCost)}
            tone={totals.customerMonthly - totals.gpuCost >= 0 ? 'positive' : 'negative'}
          />
        </div>
      </Panel>
    </section>
  );
}

function LicenseHero({ license }) {
  const status = LICENSE_STATUS_META[license.status] || LICENSE_STATUS_META.draft;
  const termLbl = LICENSE_TERM_LABELS[license.term] || license.term;
  const camResources  = (license.resources || []).filter(r => r.sku === 'cam_hd' || r.sku === 'cam_4k');
  const otherResources = (license.resources || []).filter(r => r.sku !== 'cam_hd' && r.sku !== 'cam_4k');
  const totalCamQuota  = camResources.reduce((s, r) => s + r.quota, 0);
  const provisioned    = license.utilisation?.camerasProvisioned ?? 0;
  const onlineCount    = license.utilisation?.camerasOnline      ?? 0;
  const enabledFeatures = (license.features || []).filter(f => f.enabled);
  const daysLeft = license.daysRemaining;
  const renewalSoon = daysLeft != null && daysLeft >= 0 && daysLeft <= 30;

  return (
    <div className="space-y-4">
      {/* Hero strip */}
      <article className="overflow-hidden rounded-xl border border-line bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4 text-white shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant={status.tone} className="gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${toneClass(status.tone, 'dot')}`} />
                {status.label}
              </Badge>
              <span className="text-small font-semibold text-white/65">{termLbl}</span>
              {renewalSoon && (
                <span className="inline-flex items-center gap-1 rounded-full bg-warning/20 px-2 py-0.5 text-micro font-bold text-warning">
                  <AlertTriangle className="h-3 w-3" />
                  Renews in {daysLeft}d
                </span>
              )}
            </div>
            <p className="mt-3 text-micro font-semibold uppercase tracking-[0.14em] text-white/45">
              {license.status === 'trial' ? 'Pilot — no charge' : 'Monthly cost'}
            </p>
            <p className="mt-1 bg-gradient-to-br from-white to-brand-line bg-clip-text text-display leading-none tabular-nums text-transparent">
              {fmtInr(license.mrr)}
            </p>
            <p className="mt-2 text-small font-medium text-white/70">
              ARR {fmtInr(license.arr)}
              {license.startDate && (<><span className="mx-1.5 text-white/30">·</span>since {license.startDate}</>)}
              {license.endDate && (<><span className="mx-1.5 text-white/30">·</span>ends {license.endDate}</>)}
            </p>
          </div>

          {/* Wrapping flex row, not a 3-track grid: a grid track is a column
              whether or not the width exists for it, so on a phone the third
              stat ran under the card's right edge and the `overflow-hidden`
              above clipped it. Wrapped, the stats reflow 3 → 2 → 1 as the card
              narrows and the card never outgrows its column. */}
          <div className="flex w-full flex-wrap gap-x-4 gap-y-3 rounded-lg border border-white/10 bg-white/5 px-3 py-3 backdrop-blur sm:px-4">
            <HeroStat label="Cameras" value={`${provisioned}`} sub={totalCamQuota > 0 ? `of ${totalCamQuota}` : 'allocated'} />
            <HeroStat label="Online"  value={`${onlineCount}`} sub="live now" />
            <HeroStat label="Features" value={`${enabledFeatures.length}`} sub={`of ${license.features?.length || 0}`} />
          </div>
        </div>
      </article>

      {/* Resource quotas + features */}
      <div className="settings-split gap-4">
        <article className="flex flex-col rounded-xl border border-line bg-surface p-4 sm:p-5">
          <p className="text-micro font-semibold uppercase tracking-[0.14em] text-fg-subtle">
            Resource quotas
          </p>
          <p className="mt-1 text-body font-semibold tracking-[-0.005em] text-fg">
            {license.resources.length} resource{license.resources.length === 1 ? '' : 's'} allocated
          </p>

          <div className="mt-4 space-y-3.5">
            {camResources.length > 0 && (
              <ResourceBar
                sku="cam_hd"
                label="Cameras (combined HD + 4K)"
                used={provisioned}
                quota={totalCamQuota}
                colorOverride="#3b82f6"
                IconOverride={Video}
                fmt={(q) => `${q.toLocaleString()} cameras`}
              />
            )}
            {otherResources.map(r => (
              <ResourceBar key={r.sku} sku={r.sku} used={r.used || 0} quota={r.quota} />
            ))}
          </div>

          <p className="mt-4 rounded-lg bg-surface-sunken px-3 py-2.5 text-caption leading-[1.55] text-fg-secondary">
            <span className="font-semibold text-fg">Approaching quota?</span> Contact your account manager to upgrade — or add resources to your next renewal.
          </p>
        </article>

        <article className="flex flex-col rounded-xl border border-line bg-surface p-4 sm:p-5">
          <p className="text-micro font-semibold uppercase tracking-[0.14em] text-fg-subtle">
            Features included
          </p>
          <p className="mt-1 text-body font-semibold tracking-[-0.005em] text-fg">
            {enabledFeatures.length} of {license.features?.length || 0} enabled
          </p>

          <div className="mt-3.5 space-y-2">
            {(license.features || []).map(f => {
              const meta = LICENSE_FEATURE_META[f.featureKey] || { label: f.featureKey, Icon: Sparkles, color: '#64748b' };
              const Icon = meta.Icon;
              return (
                <div
                  key={f.featureKey}
                  className="flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition"
                  style={{
                    borderColor: f.enabled ? meta.color + '40' : 'var(--line)',
                    background: f.enabled ? meta.color + '08' : 'transparent',
                    opacity: f.enabled ? 1 : 0.5,
                  }}
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md" style={{ background: meta.color + '18', color: meta.color }}>
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="flex-1 text-small font-semibold text-fg">{meta.label}</span>
                  {f.enabled
                    ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success-ink" />
                    : <span className="text-caption font-semibold text-fg-subtle">Off</span>}
                </div>
              );
            })}
          </div>
        </article>
      </div>
    </div>
  );
}

function HeroStat({ label, value, sub }) {
  return (
    // `flex-1 basis-20` — a 80px *preferred* width that grows into the spare
    // room and shrinks under pressure. Deliberately a basis and not a
    // `min-w-`: a minimum would be the very floor that pushed the card wide.
    <div className="flex-1 basis-20 text-center">
      <p className="text-micro font-bold uppercase tracking-[0.12em] text-white/45">{label}</p>
      <p className="mt-0.5 text-section font-bold tabular-nums leading-none text-white">{value}</p>
      <p className="mt-0.5 text-micro font-medium text-white/55">{sub}</p>
    </div>
  );
}

function ResourceBar({ sku, label, used, quota, colorOverride, IconOverride, fmt }) {
  const meta = LICENSE_RESOURCE_META[sku] || { label: sku, Icon: Cpu, color: '#64748b', unitLabel: '' };
  const Icon = IconOverride || meta.Icon;
  const baseColor = colorOverride || meta.color;
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const overage = used > quota;
  const color = overage || pct >= 90 ? '#dc2626' : pct >= 75 ? '#d97706' : baseColor;
  const formatter = fmt || meta.fmtQuota || ((q) => `${q.toLocaleString()} ${meta.unitLabel || ''}`);
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md" style={{ background: baseColor + '18', color: baseColor }}>
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="truncate text-small font-semibold text-fg">{label || meta.label}</span>
        </div>
        <span className="shrink-0 text-small font-semibold tabular-nums" style={{ color }}>
          {used.toLocaleString()}<span className="font-medium text-fg-subtle"> / {formatter(quota)}</span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-muted">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      {overage && (
        <p className="mt-1 text-caption font-semibold text-danger-ink">
          Over quota — contact admin for an upgrade.
        </p>
      )}
    </div>
  );
}

function BillRow({ label, detail, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <p className="text-small font-semibold tracking-[-0.005em] text-fg">{label}</p>
        <p className="mt-0.5 truncate text-micro font-medium text-fg-subtle">{detail}</p>
      </div>
      <span className="shrink-0 text-body font-semibold tabular-nums tracking-[-0.005em] text-fg">
        {fmtInr(value)}
      </span>
    </div>
  );
}

function PriceRow({ Icon, label, value, suffix }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line-subtle py-2.5 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-surface-muted text-fg-secondary">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.85} />
        </span>
        <span className="truncate text-small font-medium tracking-[-0.005em] text-fg-secondary">
          {label}
        </span>
      </div>
      <span className="shrink-0 text-body font-semibold tabular-nums tracking-[-0.005em] text-fg">
        {value}
        {suffix ? (
          <span className="ml-0.5 text-caption font-medium text-fg-subtle">{suffix}</span>
        ) : null}
      </span>
    </div>
  );
}

function Kpi({ Icon, label, value, note, accent }) {
  return (
    <article className="rounded-xl border border-line bg-surface p-3.5">
      <div className="flex items-center gap-2.5">
        <span
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md"
          style={{ backgroundColor: `${accent}14`, color: accent }}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-micro font-semibold uppercase tracking-[0.12em] text-fg-subtle">
            {label}
          </p>
          <p className="mt-0.5 truncate text-heading font-bold tracking-[-0.012em] tabular-nums text-fg">
            {value}
          </p>
        </div>
      </div>
      <p className="mt-2 truncate text-caption font-medium text-fg-muted">{note}</p>
    </article>
  );
}

function CameraTableRow({ item }) {
  const load = cameraLoad(item);
  const totalPrice = VMS_CAMERA_MONTH_INR + STORAGE_SOFTWARE_MONTH_INR + cameraAiPrice(item);
  const tokenSec = cameraTokenRate(item);
  const status = item.running
    ? { label: 'AI on', cls: 'bg-success-soft text-success-ink', dot: 'bg-success' }
    : item.error
      ? { label: 'Error', cls: 'bg-danger-soft text-danger-ink', dot: 'bg-danger' }
      : { label: 'VMS only', cls: 'bg-surface-muted text-fg-muted', dot: 'bg-line-strong' };

  return (
    <tr className="border-b border-line-subtle transition-colors last:border-b-0 hover:bg-surface-sunken/60">
      <td className="px-4 py-3">
        <p className="truncate text-body font-semibold tracking-[-0.005em] text-fg">{item.name}</p>
        <p className="mt-0.5 truncate text-caption font-medium text-fg-muted">
          {item.groupName || 'Camera'}
          {item.channel != null ? ` · CH ${item.channel}` : ''}
        </p>
      </td>
      <td className="px-3 py-3">
        <span
          className={`inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-micro font-semibold uppercase tracking-[0.06em] ${status.cls}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>
      </td>
      <td className="px-3 py-3 text-right text-small font-semibold tabular-nums tracking-[-0.005em] text-fg">
        {tokenSec > 0 ? `${fmtNumber(tokenSec, 1)} f/s` : <span className="text-fg-disabled">—</span>}
      </td>
      <td className="px-3 py-3 text-right text-small font-semibold tabular-nums tracking-[-0.005em] text-fg">
        {item.frames > 0 ? fmtChecks(item.frames) : <span className="text-fg-disabled">—</span>}
      </td>
      <td className="px-3 py-3 text-right text-small font-semibold tabular-nums tracking-[-0.005em] text-fg">
        {fmtInr(totalPrice)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${load}%`, backgroundColor: loadColor(load) }}
            />
          </div>
          <span
            className="w-9 text-right text-caption font-semibold tabular-nums"
            style={{ color: loadColor(load) }}
          >
            {load}%
          </span>
        </div>
      </td>
    </tr>
  );
}

function InternalStat({ label, value, tone = 'neutral' }) {
  const valueClass =
    tone === 'positive'
      ? 'text-success-ink'
      : tone === 'negative'
        ? 'text-danger-ink'
        : 'text-fg';
  return (
    <div className="rounded-lg border border-line bg-surface-sunken/60 p-3.5">
      <p className="text-micro font-semibold uppercase tracking-[0.12em] text-fg-subtle">{label}</p>
      <p className={`mt-1.5 text-section font-bold tabular-nums tracking-[-0.018em] ${valueClass}`}>
        {value}
      </p>
    </div>
  );
}

function AlertEmailsSection() {
  return (
    <section className="space-y-4">
      <SectionHeader
        Icon={Mail}
        title="Alert Emails"
        subtitle="Add any address, choose its priority, and pick which alerts it receives."
      />
      <AlertRecipients embedded />
    </section>
  );
}

const FEATURES_QUERY_KEY = ['settings-features'];

function FeaturesSection() {
  const queryClient = useQueryClient();
  const featuresQ = useQuery({ queryKey: FEATURES_QUERY_KEY, queryFn: featureSettingsService.list });
  // A critical feature waiting for "are you sure" before it is switched off.
  const [confirmTarget, setConfirmTarget] = useState(null);

  const mutation = useMutation({
    mutationFn: ({ key, enabled }) => featureSettingsService.update(key, enabled),
    // Optimistic: the switch flips at once and rolls back if the save fails.
    onMutate: async ({ key, enabled }) => {
      await queryClient.cancelQueries({ queryKey: FEATURES_QUERY_KEY });
      const previous = queryClient.getQueryData(FEATURES_QUERY_KEY);
      queryClient.setQueryData(FEATURES_QUERY_KEY, (groups = []) =>
        groups.map((g) => ({ ...g, items: g.items.map((i) => (i.key === key ? { ...i, enabled } : i)) })),
      );
      return { previous };
    },
    onError: (err, { name }, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(FEATURES_QUERY_KEY, ctx.previous);
      toast.error(`Couldn't update ${name}`, err?.response?.data?.message || err?.message);
    },
    onSuccess: (_data, { name, enabled }) => toast.success(`${name} turned ${enabled ? 'on' : 'off'}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: FEATURES_QUERY_KEY }),
  });

  const setFeature = (item, enabled) => {
    if (!enabled && item.critical) {
      setConfirmTarget(item);
      return;
    }
    mutation.mutate({ key: item.key, name: item.name, enabled });
  };

  return (
    <section className="space-y-4">
      <SectionHeader
        Icon={SlidersHorizontal}
        title="Feature Controls"
        subtitle="Enable only the modules this customer has purchased or needs."
      />

      {featuresQ.isLoading ? (
        <LoadingState message="Loading features…" />
      ) : featuresQ.isError ? (
        <ErrorState
          title="Couldn't load features"
          description={featuresQ.error?.message}
          onRetry={() => featuresQ.refetch()}
        />
      ) : (
        <div className="settings-panels gap-4">
          {featuresQ.data.map((group) => (
            <Panel
              key={group.id}
              title={group.title}
              aside={
                <span className="shrink-0 text-small font-medium text-fg-subtle">
                  {group.items.filter((i) => i.enabled).length} of {group.items.length} on
                </span>
              }
            >
              {group.items.map((item) => (
                <FeatureToggle
                  key={item.key}
                  item={item}
                  checked={item.enabled}
                  onChange={(enabled) => setFeature(item, enabled)}
                />
              ))}
            </Panel>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        onOpenChange={(open) => { if (!open) setConfirmTarget(null); }}
        title={confirmTarget ? `Turn off ${confirmTarget.name.toLowerCase()}?` : ''}
        description={confirmTarget ? <>{confirmTarget.note} Operators will stop getting these results until it is turned back on.</> : null}
        confirmLabel="Turn off"
        onConfirm={() =>
          mutation.mutateAsync({ key: confirmTarget.key, name: confirmTarget.name, enabled: false })
        }
      />
    </section>
  );
}

function ReportsSection() {
  const navigate = useNavigate();
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(false);
    const to = new Date();
    const from = new Date(to.getTime() - days * 864e5);
    aiService.report({ from: from.toISOString(), to: to.toISOString() })
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days]);

  const bySev = data?.bySeverity || {};
  const total = data?.total || 0;
  const byType = (data?.byType || []).slice(0, 5);
  const byCamera = (data?.byCamera || []).slice(0, 5);
  const num = (n) => Number(n || 0).toLocaleString();

  const exportCsv = () => {
    if (!data) return;
    const rows = [
      ['Drishyam Security Report'],
      ['Range', `${new Date(data.from).toLocaleString()} — ${new Date(data.to).toLocaleString()}`],
      [], ['Total events', total], ['Critical', bySev.critical || 0], ['Warning', bySev.warning || 0],
      ['Unacknowledged', data.unacked || 0], [],
      ['Event type', 'Count'], ...(data.byType || []).map((t) => [t.type, t.count]), [],
      ['Camera', 'Count'], ...(data.byCamera || []).map((c) => [c.name, c.count]),
    ];
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `drishyam-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <section className="space-y-6">
      <SectionHeader
        Icon={FileText}
        title="Reports"
        subtitle="A live summary of alerts and AI events for your account. Open the full report for daily
          trends and per-camera breakdowns, or export a CSV for management."
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTabs
          tabs={[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']].map(([id, label]) => ({ id, label }))}
          active={days}
          onChange={setDays}
        />
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={exportCsv} disabled={!data}>
            <Download /> Export CSV
          </Button>
          <Button onClick={() => navigate('/reports')}>
            <FileText /> Open full report
          </Button>
        </div>
      </div>

      {loading && !data ? (
        <div className="py-16 grid place-items-center text-fg-subtle"><Loader2 className="h-6 w-6 animate-spin text-brand" /></div>
      ) : error ? (
        <div className="py-16 text-center text-body text-danger-ink">Couldn't load the report summary.</div>
      ) : (
        <>
          <div className="settings-tiles gap-3">
            <MetricCard size="sm" icon={Bell} label="Total events" value={num(total)} sub="in this range" />
            <MetricCard size="sm" icon={AlertTriangle} label="Critical" value={num(bySev.critical)} sub="highest priority" tone="danger" />
            <MetricCard size="sm" icon={ShieldCheck} label="Warnings" value={num(bySev.warning)} sub="needs review" tone="warning" />
            <MetricCard size="sm" icon={FileText} label="Unacknowledged" value={num(data?.unacked)} sub="not yet actioned" tone="ai" />
          </div>

          <div className="settings-panels gap-4">
            <Panel title="Top event types" subtitle="Most frequent detections in this range.">
              {byType.length === 0 ? <p className="text-body text-fg-subtle">No events in this range.</p>
                : byType.map((t) => (
                  <div key={t.type} className="flex items-center justify-between py-1.5 text-body">
                    <span className="font-medium text-fg-secondary capitalize">{String(t.type).replace(/[._]/g, ' ')}</span>
                    <span className="font-bold tabular-nums text-fg">{num(t.count)}</span>
                  </div>
                ))}
            </Panel>
            <Panel title="Busiest cameras" subtitle="Where most activity happened.">
              {byCamera.length === 0 ? <p className="text-body text-fg-subtle">No events in this range.</p>
                : byCamera.map((c) => (
                  <div key={c.monitorId} className="flex items-center justify-between py-1.5 text-body">
                    <span className="min-w-0 truncate font-medium text-fg-secondary">{c.name}</span>
                    <span className="ml-2 font-bold tabular-nums text-fg">{num(c.count)}</span>
                  </div>
                ))}
            </Panel>
          </div>
        </>
      )}
    </section>
  );
}

const SECURITY_QUERY_KEY = ['settings-security'];

function SecuritySection() {
  const queryClient = useQueryClient();
  const securityQ = useQuery({ queryKey: SECURITY_QUERY_KEY, queryFn: securitySettingsService.get });
  // What the confirm dialog is asking about: { kind: 'policy', item } or { kind: 'retention', item, days }.
  const [confirm, setConfirm] = useState(null);

  // Optimistic: the control changes at once and rolls back if the save fails.
  const optimistic = async (patchFn) => {
    await queryClient.cancelQueries({ queryKey: SECURITY_QUERY_KEY });
    const previous = queryClient.getQueryData(SECURITY_QUERY_KEY);
    if (previous) queryClient.setQueryData(SECURITY_QUERY_KEY, patchFn(previous));
    return { previous };
  };
  const rollback = (ctx) => { if (ctx?.previous) queryClient.setQueryData(SECURITY_QUERY_KEY, ctx.previous); };
  const refresh = () => queryClient.invalidateQueries({ queryKey: SECURITY_QUERY_KEY });

  const policyMutation = useMutation({
    mutationFn: ({ key, enabled }) => securitySettingsService.setPolicy(key, enabled),
    onMutate: ({ key, enabled }) =>
      optimistic((s) => {
        const flip = (list) => list.map((p) => (p.key === key ? { ...p, enabled } : p));
        return { ...s, policies: flip(s.policies), privacy: flip(s.privacy) };
      }),
    onError: (err, { name }, ctx) => {
      rollback(ctx);
      toast.error(`Couldn't update ${name}`, err?.response?.data?.message || err?.message);
    },
    onSuccess: (_d, { name, enabled }) => toast.success(`${name} turned ${enabled ? 'on' : 'off'}`),
    onSettled: refresh,
  });

  const retentionMutation = useMutation({
    mutationFn: ({ key, days }) => securitySettingsService.setRetention(key, days),
    onMutate: ({ key, days }) =>
      optimistic((s) => ({ ...s, retention: s.retention.map((r) => (r.key === key ? { ...r, days } : r)) })),
    onError: (err, { name }, ctx) => {
      rollback(ctx);
      toast.error(`Couldn't update ${name.toLowerCase()}`, err?.response?.data?.message || err?.message);
    },
    onSuccess: (_d, { name, days }) => toast.success(`${name} set to ${formatRetention(days)}`),
    onSettled: refresh,
  });

  const setPolicy = (item, enabled) => {
    if (!enabled && item.critical) { setConfirm({ kind: 'policy', item }); return; }
    policyMutation.mutate({ key: item.key, name: item.name, enabled });
  };

  // Shortening retention deletes data, so it is confirmed; lengthening is not.
  const setRetention = (item, days) => {
    if (days < item.days) { setConfirm({ kind: 'retention', item, days }); return; }
    retentionMutation.mutate({ key: item.key, name: item.name, days });
  };

  const confirmCopy = !confirm
    ? {}
    : confirm.kind === 'policy'
      ? {
          title: `Turn off ${confirm.item.name.toLowerCase()}?`,
          description: <>{confirm.item.note} Turning this off weakens your security policy for every operator.</>,
          label: 'Turn off',
          run: () => policyMutation.mutateAsync({ key: confirm.item.key, name: confirm.item.name, enabled: false }),
        }
      : {
          title: `Shorten ${confirm.item.name.toLowerCase()}?`,
          description: (
            <>
              Change from <b>{formatRetention(confirm.item.days)}</b> to <b>{formatRetention(confirm.days)}</b>.
              Data older than {formatRetention(confirm.days)} will be permanently deleted and cannot be recovered.
            </>
          ),
          label: 'Shorten and delete',
          run: () => retentionMutation.mutateAsync({ key: confirm.item.key, name: confirm.item.name, days: confirm.days }),
        };

  const data = securityQ.data;

  return (
    <section className="space-y-4">
      <SectionHeader
        Icon={ShieldCheck}
        title="Security & Privacy"
        subtitle="Operator access, audit policy, and data retention."
      />

      {securityQ.isLoading ? (
        <LoadingState message="Loading security settings…" />
      ) : securityQ.isError ? (
        <ErrorState
          title="Couldn't load security settings"
          description={securityQ.error?.message}
          onRetry={() => securityQ.refetch()}
        />
      ) : (
        <div className="settings-panels gap-4">
          <Panel
            title="Access Policy"
            aside={
              <span className="shrink-0 text-small font-medium text-fg-subtle">
                {data.policies.filter((p) => p.enabled).length} of {data.policies.length} on
              </span>
            }
          >
            {data.policies.map((item) => (
              <FeatureToggle key={item.key} item={item} checked={item.enabled} onChange={(v) => setPolicy(item, v)} />
            ))}
          </Panel>
          <Panel title="Data Protection">
            {data.retention.map((item) => (
              <RetentionRow key={item.key} item={item} onChange={(days) => setRetention(item, days)} />
            ))}
            {data.privacy.map((item) => (
              <FeatureToggle key={item.key} item={item} checked={item.enabled} onChange={(v) => setPolicy(item, v)} />
            ))}
          </Panel>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title={confirmCopy.title}
        description={confirmCopy.description}
        confirmLabel={confirmCopy.label}
        onConfirm={() => confirmCopy.run?.()}
      />
    </section>
  );
}

function RetentionRow({ item, onChange }) {
  const id = `retention-${item.key}`;
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line-subtle py-2.5">
      <label htmlFor={id} className="text-small font-medium text-fg-muted">{item.name}</label>
      <select
        id={id}
        value={item.days}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8 rounded-md border border-line bg-surface px-2 text-small font-semibold text-fg shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-line-focus focus-visible:ring-[3px] focus-visible:ring-brand/25"
      >
        {item.options.map((d) => (
          <option key={d} value={d}>{formatRetention(d)}</option>
        ))}
      </select>
    </div>
  );
}

function OrganizationSection({ user, onOpenSection }) {
  const { license, loading: licenseLoading } = useMyLicense();

  // Camera quota from license_resources when available, else the placeholder.
  const licenseQuota = (license?.resources || [])
    .filter(r => r.sku === 'cam_hd' || r.sku === 'cam_4k')
    .reduce((s, r) => s + r.quota, 0);
  const cameraQuota = licenseQuota || ORG_PLACEHOLDER.cameraQuota;
  const camerasUsed = license?.utilisation?.camerasProvisioned ?? ORG_PLACEHOLDER.camerasUsed;

  const planValue = license
    ? `${LICENSE_TERM_LABELS[license.term] || license.term} · ${LICENSE_STATUS_META[license.status]?.label || license.status}`
    : (user?.subscription?.plan?.name || 'Enterprise');

  const renews = license?.endDate
    ? (license.daysRemaining != null && license.daysRemaining >= 0
        ? `${license.endDate} (${license.daysRemaining}d left)`
        : license.endDate)
    : `${ORG_PLACEHOLDER.renews} (${ORG_PLACEHOLDER.daysLeft}d left)`;

  return (
    <section className="space-y-4">
      <SectionHeader
        Icon={Building2}
        title="Organization"
        subtitle="Tenant, account, subscription, and contact settings for this deployment."
      />
      <div className="settings-panels gap-4">
        <Panel title="Account Details">
          <InfoLine label="Organization"   value={user?.organization || ORG_PLACEHOLDER.name} />
          <InfoLine label="License"        value={licenseLoading ? 'Loading…' : planValue} />
          <InfoLine label="Cameras"        value={<UsageValue used={camerasUsed} quota={cameraQuota} />} />
          <InfoLine label="Renews"         value={renews} />
          {license && license.mrr > 0 && (
            <InfoLine label="Monthly cost" value={fmtInr(license.mrr)} strong />
          )}
          <InfoLine label="Timezone"        value={ORG_PLACEHOLDER.timezone} />
          <InfoLine label="Org contact"     value={ORG_PLACEHOLDER.contact} />
          <InfoLine label="Billing contact" value={user?.email || 'Not set'} />
        </Panel>
        <Panel
          title="Integrations"
          aside={
            <span className="shrink-0 text-small font-medium text-fg-subtle">
              {ORG_PLACEHOLDER.integrations.filter((i) => i.connected).length} of {ORG_PLACEHOLDER.integrations.length} connected
            </span>
          }
        >
          {ORG_PLACEHOLDER.integrations.map((item) => (
            <IntegrationRow
              key={item.name}
              Icon={item.Icon}
              name={item.name}
              connected={item.connected}
              onOpen={item.section ? () => onOpenSection(item.section) : undefined}
            />
          ))}
        </Panel>
      </div>
    </section>
  );
}

function UsageValue({ used, quota }) {
  const pct = quota ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted" aria-hidden>
        <span
          className={`block h-full rounded-full ${pct >= 90 ? 'bg-warning' : 'bg-success'}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      {used} / {quota} used
    </span>
  );
}

// ── Customer-facing license hook ─────────────────────────────────────
// Fetches the current user's active enterprise license (if any) and exposes
// allocated quotas, enabled features, and live utilisation. Returns
// `{ license: null }` when the user is on the legacy plan model.
function useMyLicense() {
  const [license, setLicense] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const reload = async () => {
    setLoading(true);
    try {
      const lic = await licenseService.getMyLicense();
      setLicense(lic);
      setError(null);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not load license');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { license, loading, error, reload };
}

const LICENSE_RESOURCE_META = {
  cam_hd:     { label: 'HD Cameras (1080p)', Icon: Video,    color: '#3b82f6', unitLabel: 'cameras' },
  cam_4k:     { label: '4K Cameras (8MP)',   Icon: Video,    color: '#7c3aed', unitLabel: 'cameras' },
  storage_gb: { label: 'Storage',            Icon: Database, color: '#10b981', unitLabel: 'GB',
                fmtQuota: (q) => q >= 1024 * 1024 ? `${(q / (1024*1024)).toFixed(1)} PB`
                              : q >= 1024 ? `${(q / 1024).toFixed(1)} TB`
                              : `${q} GB` },
  gpu_hour:   { label: 'GPU Inference',      Icon: Cpu,      color: '#F7983A', unitLabel: 'hrs/mo' },
};

const LICENSE_FEATURE_META = {
  feat_face_rec: { label: 'Face Recognition',    Icon: Sparkles,    color: '#F7983A' },
  feat_behavior: { label: 'Behaviour Detection', Icon: AlertTriangle, color: '#7c3aed' },
  feat_lpr:      { label: 'LPR / Vehicle',       Icon: Radio,        color: '#0ea5e9' },
  feat_talkback: { label: 'Talkback Audio',      Icon: Bell,         color: '#10b981' },
  feat_mobile:   { label: 'Mobile App',          Icon: Gauge,        color: '#3b82f6' },
  feat_api:      { label: 'API Access',          Icon: KeyRound,     color: '#dc2626' },
};

const LICENSE_TERM_LABELS = {
  trial_30:  'Trial — 30 days',  trial_60: 'Trial — 60 days',  trial_90: 'Trial — 90 days',
  monthly:   'Monthly',          annual:   '1-Year',
  biennial:  '2-Year',           triennial: '3-Year',
};

const LICENSE_STATUS_META = {
  draft:      { label: 'Draft',      tone: 'neutral' },
  trial:      { label: 'Trial',      tone: 'ai' },
  active:     { label: 'Active',     tone: 'success' },
  suspended:  { label: 'Suspended',  tone: 'warning' },
  expired:    { label: 'Expired',    tone: 'danger' },
  terminated: { label: 'Terminated', tone: 'danger' },
};

function useComputeUsage() {
  const { data: groups = [] } = useGroups({ refetchInterval: 30000 });
  const [aiStatus, setAiStatus] = useState(null);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStatus = async () => {
    setRefreshing(true);
    try {
      const response = await fetch(`${AI_BASE}/status`);
      if (!response.ok) throw new Error(`AI status ${response.status}`);
      const data = await response.json();
      setAiStatus(data);
      setError('');
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || 'AI service unavailable');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const timer = window.setInterval(fetchStatus, POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const rows = useMemo(() => {
    const cameras = groups.flatMap((group) =>
      (group.cameras || []).map((camera) => ({ ...camera, groupName: group.name })),
    );
    const aiCameras = aiStatus?.cameras || {};
    const seen = new Set();

    const merged = cameras.map((camera) => {
      const monitorId = camera.monitorId;
      const runtime = aiCameras[monitorId] || {};
      if (monitorId) seen.add(monitorId);
      return {
        name: camera.name || monitorId || 'Camera',
        monitorId,
        channel: camera.channel,
        groupName: camera.groupName,
        running: runtime.running === true,
        source: runtime.source || '',
        fps: runtime.fps || 0,
        persons: runtime.persons || 0,
        frames: runtime.frames || 0,
        error: runtime.error || '',
      };
    });

    Object.entries(aiCameras).forEach(([cameraId, runtime]) => {
      if (seen.has(cameraId)) return;
      merged.push({
        name: cameraId,
        monitorId: cameraId,
        running: runtime.running === true,
        source: runtime.source || '',
        fps: runtime.fps || 0,
        persons: runtime.persons || 0,
        frames: runtime.frames || 0,
        error: runtime.error || '',
      });
    });

    return merged.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return cameraMonthlyTokens(b) - cameraMonthlyTokens(a);
    });
  }, [groups, aiStatus]);

  const totals = useMemo(() => {
    const totalCameras = rows.length;
    const activeAi = rows.filter((row) => row.running).length;
    const tokenPerSec = rows.reduce((sum, row) => sum + cameraTokenRate(row), 0);
    const tokensThisSession = rows.reduce((sum, row) => sum + Number(row.frames || 0), 0);
    const monthlyAiTokens = rows.reduce((sum, row) => sum + cameraMonthlyTokens(row), 0);
    const platformMonthly = totalCameras * (VMS_CAMERA_MONTH_INR + STORAGE_SOFTWARE_MONTH_INR);
    const aiMonthly = rows.reduce((sum, row) => sum + cameraAiPrice(row), 0);
    const gpuNodes = tokenPerSec > 0 ? Math.max(1, Math.ceil(tokenPerSec / GPU_TOKEN_CAPACITY_PER_SEC)) : 0;
    const gpuCost = gpuNodes * GPU_NODE_MONTH_INR;
    const customerMonthly = platformMonthly + aiMonthly;
    const capacityUsed = tokenPerSec > 0 ? clamp(Math.round((tokenPerSec / (gpuNodes * GPU_TOKEN_CAPACITY_PER_SEC)) * 100), 0, 100) : 0;

    return {
      totalCameras,
      activeAi,
      tokenPerSec,
      tokensThisSession,
      monthlyAiTokens,
      platformMonthly,
      aiMonthly,
      gpuNodes,
      gpuCost,
      customerMonthly,
      capacityUsed,
    };
  }, [rows]);

  return { rows, totals, error, refreshing, fetchStatus, lastUpdated };
}

// One-line section title; the description lives behind the ⓘ (same HeaderInfo
// the page headers use), so it is there when wanted without costing a row.
function SectionHeader({ Icon, title, subtitle }) {
  return (
    <div className="border-b border-line-subtle pb-3">
      <div className="flex items-center gap-3">
        {Icon ? (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <Icon className="h-4 w-4" strokeWidth={2} />
          </span>
        ) : null}
        <div className="flex min-w-0 items-center gap-1.5">
          <SectionHeading>{title}</SectionHeading>
          {subtitle ? <HeaderInfo text={subtitle} label={title} /> : null}
        </div>
      </div>
    </div>
  );
}

function Panel({ Icon, title, subtitle, aside, children, noPadding = false }) {
  return (
    <section className="w-full overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      {/* Wraps: `aside` is a button or a switch on some panels, and on a phone
          it was being compressed against the title instead of dropping to its
          own line. Padding steps up with the viewport — 12px on a phone, where
          this card already sits inside the pane's own gutter. */}
      <div className={`flex flex-wrap items-center gap-3 border-b border-line-subtle px-3 sm:px-4 ${Icon ? 'py-3.5' : 'py-3'}`}>
        {Icon ? (
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <Icon className="h-5 w-5" strokeWidth={2} />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <CardHeading>{title}</CardHeading>
          {subtitle ? (
            <p className="mt-0.5 text-small text-fg-muted">{subtitle}</p>
          ) : null}
        </div>
        {aside}
      </div>
      <div className={noPadding ? '' : 'p-3 sm:p-4'}>{children}</div>
    </section>
  );
}

function InfoLine({ label, value, strong = false }) {
  // Was a golden-ratio grid — label 38.2%, value 61.8%. The ratio reads well
  // at pane width and badly at phone width, where it is two columns of about
  // 95px and 155px and a value like an email or a long plan name has nowhere
  // to go but out. A wrapping row keeps the same line when both fit and drops
  // the value underneath when it does not; `ml-auto` holds it on the right
  // edge either way, so the column of values stays a column.
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line-subtle py-2.5 last:border-b-0">
      <span className="text-small font-medium text-fg-muted">{label}</span>
      <span
        className={`ml-auto break-words text-right tabular-nums ${
          strong ? 'text-body font-bold text-fg' : 'text-small font-semibold text-fg'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

// The whole row is the switch, so the target is the row, not a 36px pill.
// Pass `checked` + `onChange` to control it (Feature Controls, saved through the
// service); without them it keeps its own state (Security's placeholder policies).
function FeatureToggle({ item, checked, onChange }) {
  const [localEnabled, setLocalEnabled] = useState(item.enabled);
  const controlled = checked !== undefined;
  const enabled = controlled ? checked : localEnabled;
  const toggle = () => (controlled ? onChange?.(!enabled) : setLocalEnabled((v) => !v));

  return (
    // Divider on the wrapper so the row's wider hover background doesn't stretch it.
    <div className="border-b border-line-subtle py-0.5 last:border-b-0">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={toggle}
        className="group -mx-2 flex w-[calc(100%+1rem)] items-start justify-between gap-4 rounded-lg px-2 py-2.5 text-left transition hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <span className="min-w-0">
          <span className="block text-body font-medium text-fg">{item.name}</span>
          <span className="mt-0.5 block text-caption text-fg-muted">{item.note}</span>
        </span>
        <span
          aria-hidden
          className={`relative mt-px h-5 w-9 shrink-0 rounded-full transition-colors ${
            enabled ? 'bg-brand' : 'bg-line-strong'
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </span>
      </button>
    </div>
  );
}

function ChecklistItem({ title, note, done = false, onSetup }) {
  return (
    <div className="flex items-start gap-3 border-b border-line-subtle py-3 last:border-b-0">
      {done ? (
        <CheckCircle2 className="mt-px h-4.5 w-4.5 shrink-0 text-success" strokeWidth={2.25} aria-label="Done" />
      ) : (
        <Circle className="mt-px h-4.5 w-4.5 shrink-0 text-fg-disabled" strokeWidth={2} aria-label="Not done" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-fg">{title}</p>
        <p className="mt-0.5 text-small text-fg-muted">{note}</p>
      </div>
      {done ? (
        <span className="inline-flex h-8 shrink-0 items-center gap-1.5 self-center rounded-lg border border-success-line bg-success-soft px-3 text-small font-semibold text-success-ink">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Configured
        </span>
      ) : onSetup ? (
        <button
          type="button"
          onClick={onSetup}
          className="inline-flex shrink-0 items-center gap-0.5 self-center rounded-md px-1.5 py-1 text-small font-semibold text-brand-ink transition hover:bg-brand-soft"
        >
          Set up
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function IntegrationRow({ Icon, name, connected, onOpen }) {
  // Healthy rows stay quiet (dot + text); only the one needing attention gets a pill.
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-muted text-fg-secondary">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.85} />
        </span>
        <span className="truncate text-body font-medium text-fg">{name}</span>
      </span>
      {connected ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-small font-semibold text-success-ink">
          <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
          Connected
        </span>
      ) : (
        <span className="inline-flex h-7 shrink-0 items-center rounded-lg border border-line-strong bg-surface-sunken px-2.5 text-small font-semibold text-fg-secondary">
          Not configured
        </span>
      )}
    </>
  );
  // The divider lives on the wrapper so the clickable row's wider hover
  // background doesn't make its divider longer than the others.
  return (
    <div className="border-b border-line-subtle py-1 last:border-b-0">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {content}
        </button>
      ) : (
        <div className="flex items-center justify-between gap-3 py-1.5">{content}</div>
      )}
    </div>
  );
}

function StatusPill({ active }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-[0.06em] ${active ? 'border-success-line bg-success-soft text-success-ink' : 'border-line bg-surface-sunken text-fg-muted'}`}>
      {active ? 'Enabled' : 'Off'}
    </span>
  );
}

function EmptyState({ Icon, title, note }) {
  return (
    <div className="grid min-h-[240px] place-items-center rounded-lg border border-dashed border-line p-8 text-center">
      <div>
        <Icon className="mx-auto h-7 w-7 text-fg-disabled" strokeWidth={1.5} />
        <p className="mt-3 text-body font-semibold tracking-[-0.005em] text-fg-secondary">{title}</p>
        <p className="mt-1 text-caption text-fg-muted">{note}</p>
      </div>
    </div>
  );
}

function initials(value) {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'A';
}

function title(value) {
  return String(value || '').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
