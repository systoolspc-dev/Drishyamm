import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Eye, Plus, Search, Upload, UserRoundSearch, X } from 'lucide-react';
import faceWatchlistMockData from '../../data/faceWatchlistMockData';
import { loadStoredFaceWatchlistEntries, makeFaceWatchlistId, upsertStoredFaceWatchlistEntry } from '../../utils/faceWatchlistStorage';

const categories = ['Red List', 'Service', 'Safety', 'Access Review', 'Fraud Watch', 'Employee Access'];
const risks = ['Low', 'Medium', 'High', 'Critical'];
const statuses = ['Active', 'Monitoring', 'Inactive', 'Expired'];

const seedPeople = faceWatchlistMockData.watchlistManagement.persons.map((person, index) => ({
  ...person,
  category: index < 2 ? 'Red List' : categories[(index % (categories.length - 1)) + 1],
  riskLevel: index < 2 ? 'Critical' : person.riskLevel,
  face: index % 2 ? 'Beard, oval face' : 'Clean shaven, round face',
  clothing: index % 2 ? 'Dark jacket, jeans' : 'Blue shirt, black trousers',
  height: index % 3 ? '172 cm' : '181 cm',
  build: index % 2 ? 'Medium' : 'Lean',
  accessories: index % 2 ? 'Cap, backpack' : 'Glasses',
  watchReason: person.notes,
  linkedCase: `CASE-${204 + index}`,
  staffInstructions: index < 2 ? 'Do not confront alone. Notify floor supervisor and track live route.' : 'Verify identity and keep observation passive.',
  matchStatus: index < 4 ? 'Matched today' : 'No current match',
  lastSeenZone: ['Main Gate', 'Parking Area', 'Bus Bay', 'Food Court'][index % 4],
  camera: ['CAM-04', 'CAM-12', 'CAM-07', 'CAM-09'][index % 4],
  confidence: [93, 89, 86, 82, 78][index % 5],
}));

function getInitialPeople() {
  const stored = loadStoredFaceWatchlistEntries();
  return [...stored, ...seedPeople.filter((person) => !stored.some((item) => item.id === person.id))];
}

function normalizeWatchlistDate(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function isPersonDateInRange(person, from, to) {
  const value = normalizeWatchlistDate(person.retainedDate || person.dateAdded || person.lastUpdated);
  if (!value) return !from && !to;
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

const riskClass = {
  Critical: 'border-red-200 bg-red-50 text-red-700',
  High: 'border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] text-[var(--color-info-text)]',
  Medium: 'border-amber-200 bg-amber-50 text-amber-700',
  Low: 'border-emerald-200 bg-emerald-50 text-emerald-700',
};

function Badge({ children, className = '' }) {
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-bold ${className}`}>{children}</span>;
}

function Avatar({ name, photo }) {
  const initials = name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] text-xs font-bold text-[var(--color-info-text)]">
      {photo ? <img src={photo} alt="" className="h-full w-full object-cover" /> : initials}
    </div>
  );
}

function MetricCard({ icon: Icon, iconClass, label, value, sub, subClass }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center gap-4">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconClass}`}>
          <Icon size={18} />
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</div>
          <div className="text-2xl font-extrabold leading-tight text-[var(--color-on-bg)]">{value}</div>
          <div className={`mt-0.5 text-[11px] font-semibold ${subClass}`}>{sub}</div>
        </div>
      </div>
    </div>
  );
}

function WatchlistSummary({ people, onDismiss }) {
  const summary = categories.map((item) => ({
    label: item,
    value: people.filter((person) => person.category === item).length,
  }));
  const total = Math.max(1, people.length);

  return (
    <section className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-[var(--color-on-bg)]">Watchlist Summary</h2>
          <p className="text-xs text-[var(--color-text-muted)]">Red List is a high-priority category inside the Face Watchlist. Critical/High is the risk level.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-[var(--color-bg)] px-3 py-2 text-right">
            <div className="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Total</div>
            <div className="text-lg font-extrabold text-[var(--color-on-bg)]">{people.length}</div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:border-red-200 hover:bg-red-50 hover:text-red-700"
            aria-label="Hide watchlist summary"
            title="Hide summary"
          >
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {summary.map((item, index) => {
          const colors = ['#ef4444', '#6C757D', '#f59e0b', '#6C757D', '#22c55e', '#fb7185'];
          const color = colors[index % colors.length];
          const percent = Math.round((item.value / total) * 100);
          return (
            <div key={item.label} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[var(--color-text-secondary)]">{item.label}</span>
                <strong className="text-xs text-[var(--color-on-bg)]">{item.value}</strong>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-high)]">
                <div className="h-full rounded-full" style={{ width: `${percent}%`, background: color }} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function WatchlistManagementPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isWeaponIntake = searchParams.get('source') === 'weapon';
  const intakeIncident = searchParams.get('incident') || '';
  const intakeWeapon = searchParams.get('weapon') || '';
  const intakeFace = searchParams.get('face') || '';
  const intakeImage = searchParams.get('image') || '';
  const intakeNotes = searchParams.get('notes') || '';
  const [people, setPeople] = useState(getInitialPeople);
  const [selectedId, setSelectedId] = useState(() => getInitialPeople()[0]?.id);
  const [searchQuery, setSearchQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [risk, setRisk] = useState('All');
  const [status, setStatus] = useState('All');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [summaryVisible, setSummaryVisible] = useState(true);
  const [draft, setDraft] = useState(() => ({
    name: searchParams.get('name') || '',
    profileLabel: isWeaponIntake ? 'Weapon incident face capture' : '',
    category: isWeaponIntake ? 'Safety' : categories[0],
    riskLevel: isWeaponIntake ? 'High' : 'Medium',
    status: 'Active',
    aliases: isWeaponIntake ? [intakeFace && intakeFace !== 'unknown' ? intakeFace : 'Unknown face', intakeWeapon].filter(Boolean).join(', ') : '',
    watchReason: isWeaponIntake
      ? intakeNotes || `Face captured from Weapon Detection incident ${intakeIncident || 'pending review'}. Review and add more reference images for model training.`
      : '',
    linkedCase: intakeIncident || '',
    staffInstructions: isWeaponIntake
      ? `Validate identity, add supporting face images if available, label the person, and keep the weapon incident ${intakeWeapon || 'record'} linked.`
      : '',
    photo: intakeImage || '',
  }));

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return people.filter((person) => {
      if (category !== 'All' && person.category !== category) return false;
      if (risk !== 'All' && person.riskLevel !== risk) return false;
      if (status !== 'All' && person.status !== status) return false;
      if (!isPersonDateInRange(person, dateFrom, dateTo)) return false;
      if (!query) return true;
      return [
        person.name, person.id, person.category, person.status, person.aliases,
        person.watchReason, person.linkedCase, person.staffInstructions,
      ].some((value) => String(value || '').toLowerCase().includes(query));
    });
  }, [category, dateFrom, dateTo, people, risk, searchQuery, status]);

  const selected = people.find((person) => person.id === selectedId) || filtered[0] || people[0];

  const addPerson = (event) => {
    event.preventDefault();
    if (!draft.name.trim()) return;
    const newPerson = {
      ...draft,
      id: makeFaceWatchlistId(),
      name: draft.name.trim(),
      lastUpdated: '05 Jun 2026',
      retainedDate: new Date().toISOString().slice(0, 10),
      addedBy: 'Operator',
      notes: draft.watchReason,
      matchStatus: 'New entry',
      lastSeenZone: 'Awaiting first match',
      camera: 'Unassigned',
      confidence: 0,
    };
    upsertStoredFaceWatchlistEntry(newPerson);
    setPeople((items) => [newPerson, ...items]);
    setSelectedId(newPerson.id);
    setDraft({ ...draft, name: '', profileLabel: '', aliases: '', watchReason: '', linkedCase: '', staffInstructions: '', photo: '' });
  };

  return (
    <main className="face-watchlist-page min-h-full bg-[var(--color-bg)] p-4 text-[var(--color-on-bg)]">
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <MetricCard
          icon={Eye}
          iconClass="bg-[var(--color-primary-bg)] text-[var(--color-info-text)]"
          label="Watchlist Matches"
          value="1248"
          sub="+32% vs yesterday"
          subClass="text-[var(--color-info-text)]"
        />
        <MetricCard
          icon={AlertTriangle}
          iconClass="bg-red-50 text-red-700"
          label="High Risk Matches"
          value="23"
          sub="3 Critical | 20 High"
          subClass="text-red-700"
        />
        <MetricCard
          icon={UserRoundSearch}
          iconClass="bg-[var(--color-primary-bg)] text-[var(--color-info-text)]"
          label="Total Watchlist"
          value="5248"
          sub="Individuals"
          subClass="text-[var(--color-info-text)]"
        />
      </div>

      {summaryVisible ? (
        <WatchlistSummary people={people} onDismiss={() => setSummaryVisible(false)} />
      ) : (
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            onClick={() => setSummaryVisible(true)}
            className="rounded-lg border border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] px-3 py-2 text-xs font-bold text-[var(--color-info-text)] hover:bg-[var(--color-surface-high)]"
          >
            Show Watchlist Summary
          </button>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="space-y-3 border-b border-[var(--color-border)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative min-w-64 flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search name, ID, category, status, attributes, notes..." className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] py-2 pl-9 pr-3 text-xs outline-none focus:border-[var(--color-primary)]" />
              </label>
              <select value={category} onChange={(event) => setCategory(event.target.value)} className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-2 text-xs"><option>All</option>{categories.map((item) => <option key={item}>{item}</option>)}</select>
              <select value={risk} onChange={(event) => setRisk(event.target.value)} className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-2 text-xs"><option>All</option>{risks.map((item) => <option key={item}>{item}</option>)}</select>
              <select value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-2 text-xs"><option>All</option>{statuses.map((item) => <option key={item}>{item}</option>)}</select>
              <label className="face-date-filter">
                <span>From</span>
                <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
              </label>
              <label className="face-date-filter">
                <span>To</span>
                <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
              </label>
              {(dateFrom || dateTo) && (
                <button type="button" onClick={() => { setDateFrom(''); setDateTo(''); }} className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-xs font-bold text-[var(--color-text-secondary)]">
                  Clear Dates
                </button>
              )}
            </div>
          </div>
          <div className="divide-y divide-[var(--color-border)]">
            {filtered.map((person) => (
              <div key={person.id} onClick={() => setSelectedId(person.id)} className={`flex w-full cursor-pointer items-start gap-3 p-4 text-left hover:bg-[var(--color-surface-high)] ${selected?.id === person.id ? 'bg-[var(--color-primary-bg)]' : ''}`}>
                <Avatar name={person.name} photo={person.photo} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold">{person.name}</span>
                    <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{person.id}</span>
                    <Badge className={riskClass[person.riskLevel]}>{person.riskLevel}</Badge>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate(`/ai-analytics/watchlist/suspect/${person.id}`);
                      }}
                      className="rounded-md border border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--color-info-text)] hover:bg-[var(--color-surface-high)]"
                    >
                      Profile
                    </button>
                  </div>
                  <div className="mt-1 text-xs text-[var(--color-text-secondary)]">{person.profileLabel || person.category} - {person.aliases}</div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[var(--color-text-secondary)]">
                    <span>{person.category}</span><span>{person.status}</span><span>{person.lastSeenZone}</span><span>{person.camera}</span><span>{person.confidence}%</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <aside className="space-y-4">
          <form onSubmit={addPerson} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-bold"><Plus size={15} className="text-[var(--color-info-text)]" /> Add Person of Interest</div>
            {isWeaponIntake && (
              <div className="mb-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-bold text-[var(--color-danger-text)]">
                  <AlertTriangle size={14} />
                  Weapon incident intake
                </div>
                <div className="flex gap-3">
                  {intakeImage && <img src={intakeImage} alt="Weapon-linked face capture" className="h-20 w-20 rounded-lg object-cover" />}
                  <div className="min-w-0 text-xs text-[var(--color-text-secondary)]">
                    <div><strong className="text-[var(--color-text)]">Incident:</strong> {intakeIncident || 'Not provided'}</div>
                    <div><strong className="text-[var(--color-text)]">Weapon:</strong> {intakeWeapon || 'Not provided'}</div>
                    <div><strong className="text-[var(--color-text)]">Face:</strong> {intakeFace || 'Unknown'}</div>
                    <p className="mt-2">Use this captured frame as the starting image, then upload more references if needed before saving.</p>
                  </div>
                </div>
              </div>
            )}
            <div className="grid gap-2">
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Name / profile label" className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-xs" />
              <div className="grid grid-cols-2 gap-2">
                <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-xs">{categories.map((item) => <option key={item}>{item}</option>)}</select>
                <select value={draft.riskLevel} onChange={(e) => setDraft({ ...draft, riskLevel: e.target.value })} className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-xs">{risks.map((item) => <option key={item}>{item}</option>)}</select>
              </div>
              <input value={draft.aliases} onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} placeholder="Aliases" className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-xs" />
              <textarea value={draft.watchReason} onChange={(e) => setDraft({ ...draft, watchReason: e.target.value })} placeholder="Watch reason / notes" className="min-h-16 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-xs" />
              <input value={draft.linkedCase} onChange={(e) => setDraft({ ...draft, linkedCase: e.target.value })} placeholder="Linked case" className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-xs" />
              <textarea value={draft.staffInstructions} onChange={(e) => setDraft({ ...draft, staffInstructions: e.target.value })} placeholder="Staff instructions" className="min-h-16 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-xs" />
              <label className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
                <Upload size={14} /> Upload reference photo
                <input type="file" className="hidden" onChange={(e) => setDraft({ ...draft, photo: e.target.files?.[0]?.name || '' })} />
              </label>
              <button className="rounded-lg bg-[var(--action-primary)] px-3 py-2 text-xs font-bold text-[var(--action-primary-text)]">Add Person</button>
            </div>
          </form>

          {selected && (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="mb-3 flex items-center gap-3">
                <Avatar name={selected.name} photo={selected.photo} />
                <div><div className="text-sm font-bold">{selected.name}</div><div className="text-xs text-[var(--color-text-muted)]">{selected.id} - {selected.category}</div></div>
              </div>
              <div className="grid gap-2 text-xs text-[var(--color-text-secondary)]">
                {[
                  ['Match Status', selected.matchStatus],
                  ['Last Seen Zone', selected.lastSeenZone],
                  ['Camera', selected.camera],
                  ['Confidence', `${selected.confidence}%`],
                  ['Linked Case', selected.linkedCase],
                  ['Staff Instructions', selected.staffInstructions],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-[var(--color-bg)] p-3">
                    <div className="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">{label}</div>
                    <div className="mt-1">{value}</div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => navigate(`/ai-analytics/watchlist/suspect/${selected.id}`)}
                className="mt-3 w-full rounded-lg bg-[var(--action-primary)] px-3 py-2 text-xs font-bold text-[var(--action-primary-text)] hover:bg-[var(--action-primary-hover)]"
              >
                Open Full Profile
              </button>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
