import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Brain,
  Camera,
  Car,
  Download,
  FileText,
  MessageSquare,
  Navigation,
  Radio,
  Search,
  Shield,
  Users,
} from 'lucide-react';
import faceWatchlistMockData from '../../data/faceWatchlistMockData';

const tabs = [
  { id: 'movementHistory', label: 'Movement', icon: Navigation },
  { id: 'incidents', label: 'Incidents', icon: AlertTriangle },
  { id: 'associates', label: 'Associates', icon: Users },
  { id: 'vehicles', label: 'Vehicles', icon: Car },
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'notes', label: 'Notes', icon: MessageSquare },
];

const severityClass = {
  Critical: 'bg-red-50 text-red-700 border-red-200',
  High: 'bg-[var(--color-primary-bg)] text-[var(--color-info-text)] border-[var(--color-border-accent)]',
  Medium: 'bg-amber-50 text-amber-700 border-amber-200',
  Low: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Flagged: 'bg-red-50 text-red-700 border-red-200',
  Open: 'bg-red-50 text-red-700 border-red-200',
  Resolved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Under Review': 'bg-[var(--color-primary-bg)] text-[var(--color-info-text)] border-[var(--color-border-accent)]',
  Matched: 'bg-[var(--color-primary-bg)] text-[var(--color-info-text)] border-[var(--color-border-accent)]',
};

function Badge({ children, type }) {
  return (
    <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-semibold ${severityClass[type] || 'border-[var(--color-border-strong)] bg-[var(--color-surface-high)] text-[var(--color-text-secondary)]'}`}>
      {children}
    </span>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)]/70 py-2 last:border-0">
      <span className="text-[11px] text-[var(--color-text-muted)]">{label}</span>
      <span className="text-right text-[11px] font-semibold text-[var(--color-on-bg)]">{value}</span>
    </div>
  );
}

function Avatar({ name, photo }) {
  const initials = name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border-2 border-red-200 bg-red-50 text-xl font-bold text-red-700">
      {photo ? <img src={photo} alt="" className="h-full w-full object-cover" /> : initials}
    </div>
  );
}

const riskScoreByLevel = {
  Critical: '94 / 100',
  High: '86 / 100',
  Medium: '64 / 100',
  Low: '28 / 100',
};

const cameras = ['CAM-04', 'CAM-07', 'CAM-01', 'CAM-02', 'CAM-09', 'CAM-12', 'CAM-05'];
const locations = ['Main Gate', 'Bus Bay', 'North Entry', 'Parking Area', 'Cafeteria', 'Parking Area', 'Service Corridor'];

function buildProfile(person, index) {
  const base = faceWatchlistMockData.suspectProfile;
  const isBaseProfile = person.id === base.id;
  if (isBaseProfile) return base;

  const camera = cameras[index % cameras.length];
  const location = locations[index % locations.length];
  const riskScore = riskScoreByLevel[person.riskLevel] || riskScoreByLevel.Medium;
  const confidence = [93, 89, 86, 85, 77, 82, 88][index % 7];
  const relatedPeople = faceWatchlistMockData.watchlistManagement.persons
    .filter((item) => item.id !== person.id)
    .slice(0, 4);

  return {
    ...base,
    id: person.id,
    name: person.name,
    riskLabel: `${person.riskLevel} Risk`,
    photo: person.photo,
    keyInfo: {
      ...base.keyInfo,
      aliases: person.aliases || 'No known aliases',
      criminalType: person.category,
      riskScore,
      watchlistSince: person.lastUpdated,
    },
    lastSeen: {
      date: '05 May 2026',
      time: ['14:20:31', '14:18:45', '14:16:22', '14:15:11', '14:13:02'][index % 5],
      camera,
      location,
    },
    knownVehicles: index % 2 === 0 ? base.knownVehicles : ['No vehicle linked'],
    associatedIncidents: Math.max(1, 12 - index),
    movementMapPoints: base.movementMapPoints.map((point, pointIndex) => ({
      ...point,
      camera: cameras[(index + pointIndex) % cameras.length],
      location: locations[(index + pointIndex) % locations.length],
      x: Math.max(15, Math.min(85, point.x + ((index % 3) - 1) * 8)),
      y: Math.max(20, Math.min(82, point.y + ((index % 4) - 1) * 6)),
    })),
    tabs: {
      ...base.tabs,
      movementHistory: base.tabs.movementHistory.map((row, rowIndex) => ({
        ...row,
        location: locations[(index + rowIndex) % locations.length],
        camera: cameras[(index + rowIndex) % cameras.length],
        confidence: Math.max(70, confidence - rowIndex * 2),
      })),
      incidents: [
        {
          id: `INC-${204 + index}`,
          date: '05 May 2026',
          type: person.category === 'Missing Person' ? 'Missing Person Sighting' : 'Watchlist Alert',
          location,
          severity: person.riskLevel === 'Low' ? 'Low' : person.riskLevel,
          status: person.status === 'Active' ? 'Open' : 'Under Review',
        },
        ...base.tabs.incidents.slice(1, 4),
      ],
      associates: relatedPeople.map((item, assocIndex) => ({
        name: item.name,
        relation: assocIndex === 0 ? 'Known associate' : 'Linked watchlist profile',
        riskLevel: item.riskLevel,
        sharedIncidents: Math.max(1, 4 - assocIndex),
      })),
      notes: [
        {
          date: person.lastUpdated,
          author: person.addedBy || 'Operator',
          text: person.notes || 'Profile monitored by face watchlist operators.',
        },
        ...base.tabs.notes.slice(1),
      ],
    },
  };
}

export default function SuspectProfilePage() {
  const { personId } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('movementHistory');
  const people = faceWatchlistMockData.watchlistManagement.persons;
  const selectedIndex = Math.max(0, people.findIndex((person) => person.id === personId));
  const selectedPerson = people[selectedIndex] || people[0];
  const profile = useMemo(() => buildProfile(selectedPerson, selectedIndex), [selectedIndex, selectedPerson]);
  const activeRows = profile.tabs[activeTab] || [];

  if (!personId) {
    return (
      <main className="face-watchlist-page min-h-full bg-[var(--color-bg)] p-4 text-[var(--color-on-bg)]">
        <section className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-[var(--color-on-bg)]">People Profiles</h2>
              <p className="text-xs text-[var(--color-text-muted)]">Select a person to open their full face watchlist profile.</p>
            </div>
            <button
              type="button"
              onClick={() => navigate('/ai-analytics/watchlist/watchlist')}
              className="rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-xs font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-high)]"
            >
              Manage Watchlist
            </button>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {people.map((person, index) => {
            const camera = cameras[index % cameras.length];
            const location = locations[index % locations.length];
            const confidence = [93, 89, 86, 85, 77, 82, 88][index % 7];
            return (
              <button
                key={person.id}
                type="button"
                onClick={() => navigate(`/ai-analytics/watchlist/suspect/${person.id}`)}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left transition hover:border-[var(--color-primary)] hover:bg-[var(--color-surface-high)]"
              >
                <div className="mb-4 flex items-start gap-3">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] text-xs font-bold text-[var(--color-info-text)]">
                    {person.photo ? <img src={person.photo} alt="" className="h-full w-full object-cover" /> : person.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold text-[var(--color-on-bg)]">{person.name}</div>
                    <div className="font-mono text-[10px] text-[var(--color-text-muted)]">{person.id}</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge type={person.riskLevel}>{person.riskLevel}</Badge>
                      <Badge type={person.status}>{person.status}</Badge>
                    </div>
                  </div>
                </div>
                <div className="grid gap-2 text-xs text-[var(--color-text-secondary)]">
                  <InfoRow label="Category" value={person.category} />
                  <InfoRow label="Last Seen" value={location} />
                  <InfoRow label="Camera" value={camera} />
                  <InfoRow label="Confidence" value={`${confidence}%`} />
                </div>
                <div className="mt-3 rounded-lg bg-[var(--action-primary)] px-3 py-2 text-center text-xs font-bold text-[var(--action-primary-text)]">
                  Open Profile
                </div>
              </button>
            );
          })}
        </section>
      </main>
    );
  }

  return (
    <main className="face-watchlist-page min-h-full bg-[var(--color-bg)] p-4 text-[var(--color-on-bg)]">
      <div className="grid grid-cols-12 gap-4">
        <aside className="col-span-12 space-y-4 lg:col-span-3">
          <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-[var(--color-on-bg)]">All Profiles</h3>
                <p className="text-[11px] text-[var(--color-text-muted)]">{people.length} watchlist people</p>
              </div>
              <button
                type="button"
                onClick={() => navigate('/ai-analytics/watchlist/watchlist')}
                className="rounded-md border border-[var(--color-border-strong)] px-2 py-1 text-[10px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-high)]"
              >
                Manage
              </button>
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {people.map((person, index) => {
                const isActive = person.id === selectedPerson.id;
                return (
                  <button
                    key={person.id}
                    type="button"
                    onClick={() => navigate(`/ai-analytics/watchlist/suspect/${person.id}`)}
                    className={`flex w-full items-center gap-3 rounded-lg border p-2 text-left transition ${isActive ? 'border-[var(--color-border-accent)] bg-[var(--color-primary-bg)]' : 'border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-surface-high)]'}`}
                  >
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] text-[10px] font-bold text-[var(--color-info-text)]">
                      {person.photo ? <img src={person.photo} alt="" className="h-full w-full object-cover" /> : person.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-bold text-[var(--color-on-bg)]">{person.name}</div>
                      <div className="truncate font-mono text-[9px] text-[var(--color-text-muted)]">{person.id} - {person.category}</div>
                    </div>
                    <Badge type={person.riskLevel}>{person.riskLevel}</Badge>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <h3 className="mb-3 text-sm font-bold text-[var(--color-on-bg)]">Quick Actions</h3>
            <div className="grid gap-2">
              {[
                { label: 'Journey Mapping', icon: Navigation, primary: true, onClick: () => navigate(`/ai-analytics/watchlist/reid/${profile.id}`) },
                { label: 'View Cameras', icon: Camera },
                { label: 'Behaviour Review', icon: Brain, onClick: () => navigate(`/ai-analytics/watchlist/behavior/${profile.id}`) },
                { label: 'Alert Security', icon: Radio },
                { label: 'Export Report', icon: Download },
                { label: 'Search Incidents', icon: Search },
                { label: 'Security Review', icon: Shield },
              ].map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.label}
                    type="button"
                    onClick={action.onClick}
                    className={`${action.primary ? 'bg-[var(--action-primary)] text-[var(--action-primary-text)] hover:bg-[var(--action-primary-hover)]' : 'bg-[var(--color-surface-high)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-low)]'} flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold`}
                  >
                    <Icon size={13} /> {action.label}
                  </button>
                );
              })}
            </div>
          </section>
        </aside>

        <section className="col-span-12 space-y-4 lg:col-span-9">
          <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="grid gap-4 xl:grid-cols-[260px_1fr_220px]">
              <div>
                <div className="mb-4 inline-flex rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                  {profile.riskLabel}
                </div>
                <div className="flex items-center gap-4">
                  <Avatar name={profile.name} photo={profile.photo} />
                  <div>
                    <h2 className="text-lg font-bold text-[var(--color-on-bg)]">{profile.name}</h2>
                    <p className="font-mono text-[11px] text-[var(--color-text-muted)]">{profile.id}</p>
                    <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{profile.keyInfo.criminalType}</p>
                    <button
                      type="button"
                      onClick={() => navigate(`/ai-analytics/watchlist/reid/${profile.id}`)}
                      className="mt-3 inline-flex items-center gap-2 rounded-lg bg-[var(--action-primary)] px-3 py-2 text-xs font-bold text-[var(--action-primary-text)] hover:bg-[var(--action-primary-hover)]"
                    >
                      <Navigation size={13} /> Journey Mapping
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid gap-2 md:grid-cols-2">
                <InfoRow label="Aliases" value={profile.keyInfo.aliases} />
                <InfoRow label="DOB" value={profile.keyInfo.dateOfBirth} />
                <InfoRow label="Nationality" value={profile.keyInfo.nationality} />
                <InfoRow label="Watchlist Since" value={profile.keyInfo.watchlistSince} />
                <InfoRow label="Known Vehicles" value={profile.knownVehicles.join(', ')} />
                <InfoRow label="Associated Incidents" value={profile.associatedIncidents} />
                <button
                  type="button"
                  onClick={() => navigate(`/ai-analytics/watchlist/relationship/${profile.id}`)}
                  className="md:col-span-2 mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--action-primary)] px-3 py-2 text-xs font-bold text-[var(--action-primary-text)] hover:bg-[var(--action-primary-hover)]"
                >
                  <Users size={13} /> Relationship Graph
                </button>
                <button
                  type="button"
                  onClick={() => navigate(`/ai-analytics/watchlist/behavior/${profile.id}`)}
                  className="md:col-span-2 inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] px-3 py-2 text-xs font-bold text-[var(--color-info-text)] hover:bg-[var(--color-surface-high)]"
                >
                  <Brain size={13} /> Behaviour Review
                </button>
              </div>

              <div className="grid gap-3">
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-center">
                  <div className="text-3xl font-bold text-[var(--color-info-text)]">{profile.keyInfo.riskScore.split(' / ')[0]}</div>
                  <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Risk Score</div>
                </div>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                  <h3 className="mb-2 text-xs font-bold text-[var(--color-on-bg)]">Last Seen</h3>
                  <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-on-bg)]">
                    <Camera size={13} className="text-[var(--color-info-text)]" /> {profile.lastSeen.camera}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{profile.lastSeen.location}</div>
                  <div className="mt-1 font-mono text-[11px] text-[var(--color-info-text)]">{profile.lastSeen.date} - {profile.lastSeen.time}</div>
                </div>
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="flex overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-bg)]">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`${isActive ? 'border-[var(--color-primary)] bg-[var(--color-primary-bg)] text-[var(--color-info-text)]' : 'border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-high)] hover:text-[var(--color-on-bg)]'} flex flex-shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-xs font-semibold`}>
                    <Icon size={13} /> {tab.label}
                    <span className="rounded-full bg-[var(--color-surface-high)] px-1.5 text-[9px]">{(profile.tabs[tab.id] || []).length}</span>
                  </button>
                );
              })}
            </div>

            <div className="max-h-[520px] overflow-y-auto p-4">
              <div className="space-y-3">
                {activeRows.map((item, index) => (
                  <div key={index} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                    {activeTab === 'movementHistory' && (
                      <div className="grid gap-2 text-xs sm:grid-cols-5">
                        <span className="font-mono text-[var(--color-info-text)]">{item.time}</span>
                        <span className="text-[var(--color-text-secondary)]">{item.date}</span>
                        <span className="font-semibold text-[var(--color-on-bg)]">{item.location}</span>
                        <span className="font-mono text-[var(--color-info-text)]">{item.camera}</span>
                        <Badge type={item.status}>{item.confidence}% {item.status}</Badge>
                      </div>
                    )}
                    {activeTab === 'incidents' && (
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-[var(--color-on-bg)]">{item.type}</div>
                          <div className="text-[11px] text-[var(--color-text-muted)]">{item.location} - {item.date}</div>
                        </div>
                        <div className="flex gap-2"><Badge type={item.severity}>{item.severity}</Badge><Badge type={item.status}>{item.status}</Badge></div>
                      </div>
                    )}
                    {activeTab === 'associates' && (
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-[var(--color-on-bg)]">{item.name}</div>
                          <div className="text-[11px] text-[var(--color-text-muted)]">{item.relation}</div>
                        </div>
                        <Badge type={item.riskLevel}>{item.riskLevel}</Badge>
                      </div>
                    )}
                    {activeTab === 'vehicles' && (
                      <div className="grid gap-2 text-xs sm:grid-cols-5">
                        <span className="font-mono font-bold text-[var(--color-info-text)]">{item.plate}</span>
                        <span className="text-[var(--color-text-secondary)]">{item.make}</span>
                        <span className="text-[var(--color-text-secondary)]">{item.type}</span>
                        <span className="text-[var(--color-text-secondary)]">{item.lastSeen}</span>
                        <Badge type={item.status}>{item.status}</Badge>
                      </div>
                    )}
                    {activeTab === 'documents' && (
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-[var(--color-on-bg)]">{item.name}</div>
                          <div className="text-[11px] text-[var(--color-text-muted)]">{item.type} - {item.date} - {item.addedBy}</div>
                        </div>
                        <Download size={14} className="text-[var(--color-text-muted)]" />
                      </div>
                    )}
                    {activeTab === 'notes' && (
                      <div>
                        <div className="mb-1 text-[11px] font-semibold text-[var(--color-info-text)]">{item.author} <span className="font-normal text-[var(--color-text-muted)]">{item.date}</span></div>
                        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{item.text}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
