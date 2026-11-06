import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, GitBranch, ShieldAlert, UserPlus, Users, Video, X } from 'lucide-react';
import faceWatchlistMockData from '../../data/faceWatchlistMockData';
import { loadStoredFaceWatchlistEntries, makeFaceWatchlistId, upsertStoredFaceWatchlistEntry } from '../../utils/faceWatchlistStorage';
import { buildPersonGraph } from '../../utils/relationshipEngine';

const nodeTone = {
  Critical: { bg: '#ef4444', text: '#ffffff' },
  High: { bg: '#0A1F44', text: '#ffffff' },
  Medium: { bg: '#6C757D', text: '#ffffff' },
  Low: { bg: '#1f7a4d', text: '#ffffff' },
};

const linkTone = {
  primary: { bg: 'var(--rg-primary-bg)', border: 'var(--rg-primary-border)', text: 'var(--rg-primary-text)', badgeBg: 'var(--rg-primary-badge)' },
  strong: { bg: 'var(--rg-strong-bg)', border: 'var(--rg-strong-border)', text: 'var(--rg-strong-text)', badgeBg: 'var(--rg-strong-badge)' },
  medium: { bg: 'var(--rg-medium-bg)', border: 'var(--rg-medium-border)', text: 'var(--rg-medium-text)', badgeBg: 'var(--rg-medium-badge)' },
  weak: { bg: 'var(--rg-weak-bg)', border: 'var(--rg-weak-border)', text: 'var(--rg-weak-text)', badgeBg: 'var(--rg-weak-badge)' },
};

const linkLabels = {
  strong: 'Strong Link',
  medium: 'Moderate Link',
  weak: 'Weak Link',
  primary: 'Selected Profile',
};

const watchlistCategories = ['Access Review', 'Fraud Watch', 'Safety', 'Service', 'Employee Access'];
const watchlistRisks = ['Medium', 'High', 'Critical', 'Low'];
const watchlistStatuses = ['Active', 'Monitoring', 'Inactive', 'Expired'];

function initials(name) {
  return name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}


function NodeIcon({ node }) {
  if (node.type === 'incident') return <ShieldAlert size={18} />;
  if (node.type === 'vehicle') return <Video size={18} />;
  return <Users size={18} />;
}

function makeVehicleOwnerDraft(vehiclePlate) {
  return {
    name: vehiclePlate ? `Unknown owner - ${vehiclePlate}` : 'Unknown owner',
    aliases: '',
    category: 'Access Review',
    riskLevel: 'High',
    status: 'Monitoring',
    linkedCase: vehiclePlate ? `ANPR-${vehiclePlate}` : 'ANPR-review',
    watchReason: vehiclePlate
      ? `Vehicle Intelligence unresolved owner review for ${vehiclePlate}. Add face identity once operator has owner, PUC, or visual evidence.`
      : 'Vehicle Intelligence unresolved owner review.',
    staffInstructions: 'Verify identity through PUC/owner detail, keep passive observation, and attach relationship evidence before field action.',
  };
}

function AddVehicleOwnerModal({ draft, setDraft, vehiclePlate, onClose, onSave }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="modal-box max-w-3xl" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Add Owner to Face Watchlist</h2>
            <p>Store this vehicle-owner identity with ANPR relationship evidence attached.</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div className="grid gap-3">
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Known owner / profile label" className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-on-bg)] outline-none focus:border-[var(--color-primary)]" />
              <div className="grid gap-3 md:grid-cols-3">
                <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-on-bg)]">
                  {watchlistCategories.map((item) => <option key={item}>{item}</option>)}
                </select>
                <select value={draft.riskLevel} onChange={(event) => setDraft({ ...draft, riskLevel: event.target.value })} className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-on-bg)]">
                  {watchlistRisks.map((item) => <option key={item}>{item}</option>)}
                </select>
                <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })} className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-on-bg)]">
                  {watchlistStatuses.map((item) => <option key={item}>{item}</option>)}
                </select>
              </div>
              <input value={draft.aliases} onChange={(event) => setDraft({ ...draft, aliases: event.target.value })} placeholder="Aliases / PUC reference / owner phone if available" className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-on-bg)] outline-none focus:border-[var(--color-primary)]" />
              <textarea value={draft.watchReason} onChange={(event) => setDraft({ ...draft, watchReason: event.target.value })} placeholder="Reason for watchlist entry" className="min-h-24 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-on-bg)] outline-none focus:border-[var(--color-primary)]" />
              <textarea value={draft.staffInstructions} onChange={(event) => setDraft({ ...draft, staffInstructions: event.target.value })} placeholder="Operator instructions" className="min-h-20 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-on-bg)] outline-none focus:border-[var(--color-primary)]" />
            </div>
            <aside className="rounded-xl border border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] p-4">
              <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-info-text)]">Evidence Context</div>
              <div className="mt-3 grid gap-2 text-xs text-[var(--color-text-secondary)]">
                <div className="rounded-lg bg-[var(--color-surface)] p-3"><div className="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Vehicle Plate</div><div className="mt-1 font-mono text-sm font-bold text-[var(--color-on-bg)]">{vehiclePlate || 'Unassigned'}</div></div>
                <div className="rounded-lg bg-[var(--color-surface)] p-3"><div className="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Source</div><div className="mt-1">Vehicle Intelligence relationship graph</div></div>
                <div className="rounded-lg bg-[var(--color-surface)] p-3"><div className="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Case</div><div className="mt-1">{draft.linkedCase}</div></div>
              </div>
            </aside>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={onSave}><UserPlus size={15} /> Add to Face Watchlist</button>
        </div>
      </section>
    </div>
  );
}

export default function RelationshipGraphPage() {
  const { personId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [storedPeople, setStoredPeople] = useState(loadStoredFaceWatchlistEntries);
  const people = useMemo(() => {
    const seeded = faceWatchlistMockData.watchlistManagement.persons;
    return [...storedPeople, ...seeded.filter((person) => !storedPeople.some((item) => item.id === person.id))];
  }, [storedPeople]);
  const vehiclePlate = params.get('vehiclePlate');
  const vehicleLinkedPerson = vehiclePlate
    ? people.find((person) => {
      const haystack = `${person.notes || ''} ${person.name || ''}`.toLowerCase();
      return haystack.includes(vehiclePlate.toLowerCase());
    })
    : null;
  const selectedIdentity = personId || vehicleLinkedPerson?.id;
  const selectedIndex = Math.max(0, people.findIndex((person) => person.id === selectedIdentity));
  const unresolvedVehicleOwner = vehiclePlate && !vehicleLinkedPerson
    ? {
      id: `unknown-owner-${vehiclePlate}`,
      name: `Unknown Owner - ${vehiclePlate}`,
      category: 'Vehicle Owner Investigation',
      riskLevel: 'High',
      status: 'Monitoring',
      notes: `Unresolved owner identity linked to ${vehiclePlate}.`,
    }
    : null;
  const selectedPerson = unresolvedVehicleOwner || people[selectedIndex] || people[0];
  const nodes = useMemo(
    () => buildPersonGraph({ selectedPerson, allPeople: people, vehiclePlate }),
    [people, selectedPerson, vehiclePlate],
  );
  const [activeNodeId, setActiveNodeId] = useState(selectedPerson.id);
  const [showAddOwner, setShowAddOwner] = useState(false);
  const [savedOwnerId, setSavedOwnerId] = useState(null);
  const [ownerDraft, setOwnerDraft] = useState(() => makeVehicleOwnerDraft(vehiclePlate));
  const center = nodes[0];
  const activeNode = nodes.find((node) => node.id === activeNodeId) || center;

  const saveVehicleOwnerToWatchlist = () => {
    const name = ownerDraft.name.trim() || `Unknown owner - ${vehiclePlate}`;
    const newPerson = {
      id: makeFaceWatchlistId(),
      photo: null,
      name,
      aliases: ownerDraft.aliases || vehiclePlate || '',
      profileLabel: name,
      category: ownerDraft.category,
      riskLevel: ownerDraft.riskLevel,
      status: ownerDraft.status,
      lastUpdated: '05 Jun 2026',
      retainedDate: new Date().toISOString().slice(0, 10),
      addedBy: 'Vehicle Intelligence',
      notes: `${ownerDraft.watchReason} Vehicle: ${vehiclePlate || 'Unknown'}.`,
      watchReason: ownerDraft.watchReason,
      linkedCase: ownerDraft.linkedCase,
      staffInstructions: ownerDraft.staffInstructions,
      matchStatus: 'Vehicle-owner review',
      lastSeenZone: 'Vehicle Intelligence',
      camera: 'ANPR',
      confidence: 0,
      face: 'Pending face reference',
      clothing: 'Unknown',
      height: 'Unknown',
      build: 'Unknown',
      accessories: 'Unknown',
      sourceVehiclePlate: vehiclePlate,
      sourceModule: 'vehicle-relationship-graph',
    };
    const updated = upsertStoredFaceWatchlistEntry(newPerson);
    setStoredPeople(updated);
    setSavedOwnerId(newPerson.id);
    setShowAddOwner(false);
    setActiveNodeId(newPerson.id);
  };

  return (
    <main className="face-watchlist-page relationship-graph-page min-h-full bg-[var(--color-bg)] p-4 text-[var(--color-on-bg)]" style={{ background: 'var(--color-bg)', color: 'var(--color-on-bg)' }}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
        <div>
          <div className="flex items-center gap-2">
            <GitBranch size={18} className="text-[var(--color-info-text)]" />
            <h2 className="text-base font-bold">Relationship Graph</h2>
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {vehiclePlate ? `${vehiclePlate} / Vehicle Intelligence cross-module relationship query` : `${selectedPerson.name} / ${selectedPerson.id} / association and evidence network`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => vehiclePlate ? navigate(`/ai-analytics/vehicle/profile?plate=${vehiclePlate}`) : navigate(`/ai-analytics/watchlist/suspect/${selectedPerson.id}`)}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-xs font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-high)]"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            <ArrowLeft size={14} /> {vehiclePlate ? 'Back to Vehicle Profile' : 'Back to Profile'}
          </button>
          {vehiclePlate && (
            <button
              type="button"
              onClick={() => setShowAddOwner(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--action-primary)] px-3 py-2 text-xs font-bold text-[var(--action-primary-text)] shadow-[0_12px_28px_rgba(255,107,53,.24)] hover:bg-[var(--action-primary-hover)]"
            >
              <UserPlus size={14} /> Add to Face Watchlist
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="relationship-graph-canvas relative min-h-[620px] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="relationship-graph-grid absolute inset-0" />
          <div className="absolute left-4 top-4 z-20 rounded-lg border px-3 py-2 text-[10px] font-bold uppercase tracking-wide" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}>
            Tap a node to inspect evidence
          </div>
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            {nodes.slice(1).map((node) => {
              const width = node.strength === 'strong' ? 0.65 : node.strength === 'medium' ? 0.45 : 0.28;
              return (
                <g key={`${center.id}-${node.id}`}>
                  <line
                    x1={center.x}
                    y1={center.y}
                    x2={node.x}
                    y2={node.y}
                    stroke={node.strength === 'weak' ? 'var(--rg-line-weak)' : node.strength === 'medium' ? 'var(--rg-line-medium)' : 'var(--rg-line-strong)'}
                    strokeWidth={width}
                    strokeDasharray={node.strength === 'weak' ? '3 3' : '0'}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })}
          </svg>

          {nodes.map((node) => {
            const tone = nodeTone[node.riskLevel] || nodeTone.Medium;
            const relationTone = linkTone[node.strength] || linkTone.medium;
            const active = activeNode.id === node.id;
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => setActiveNodeId(node.id)}
                className="absolute z-10 -translate-x-1/2 -translate-y-1/2 text-left"
                style={{ left: `${node.x}%`, top: `${node.y}%` }}
              >
                <span
                  className={`relationship-node-card flex min-w-40 items-center gap-3 rounded-xl border p-3 shadow-2xl transition ${active ? 'scale-105 is-active' : 'hover:scale-[1.03]'}`}
                  style={{
                    background: node.type === 'selected' ? 'var(--rg-selected-bg)' : relationTone.bg,
                    borderColor: active ? 'var(--color-primary)' : relationTone.border,
                  }}
                >
                  <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-sm font-bold" style={{ background: tone.bg, color: tone.text, boxShadow: 'inset 0 1px 0 rgba(255,255,255,.18)' }}>
                    {node.type === 'person' || node.type === 'selected' ? initials(node.label) : <NodeIcon node={node} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-bold text-[var(--color-on-bg)]">{node.label}</span>
                    <span className="mt-1 block truncate text-[10px] text-[var(--color-text-secondary)]">{node.category}</span>
                    <span className="mt-2 inline-flex rounded px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: relationTone.badgeBg, color: relationTone.text, border: `1px solid ${relationTone.border}` }}>
                      {linkLabels[node.strength]}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
          <div className="absolute bottom-4 left-4 z-20 flex flex-wrap gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/95 p-3 text-[10px] text-[var(--color-text-secondary)]" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}>
            <span className="flex items-center gap-1"><i className="h-2 w-6 rounded bg-[var(--action-primary)]" /> Confirmed link</span>
            <span className="flex items-center gap-1"><i className="h-px w-6 border-t border-dashed border-slate-400" /> Weak link</span>
            <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded bg-red-500" /> Critical</span>
            <span className="flex items-center gap-1"><i className="h-2.5 w-2.5 rounded bg-[var(--action-primary)]" /> High / Strong</span>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-xl border border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] p-4">
            <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-info-text)]">How to Read</div>
            <p className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)]">
              The selected watchlist person is in the center. Connected cards are people, vehicle, or incident relationships. Click any card to inspect its evidence.
            </p>
          </section>

          <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
            <div className="mb-3 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Selected Node</div>
            <div className="flex items-center gap-3">
              <div className="relationship-side-avatar flex h-12 w-12 items-center justify-center rounded-lg text-sm font-bold">
                {activeNode.type === 'person' || activeNode.type === 'selected' ? initials(activeNode.label) : <NodeIcon node={activeNode} />}
              </div>
              <div>
                <h3 className="text-sm font-bold">{activeNode.label}</h3>
                <p className="text-xs text-[var(--color-text-muted)]">{activeNode.category} / {activeNode.riskLevel}</p>
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3" style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }}>
              <div className="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Relationship</div>
              <div className="mt-1 text-sm font-semibold text-[var(--color-on-bg)]">{activeNode.relation}</div>
            </div>
          </section>

          <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
            <h3 className="mb-3 text-sm font-bold">Evidence Signals</h3>
            <div className="space-y-2">
              {activeNode.evidence.map((item) => (
                <div key={item} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-secondary)]" style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}>
                  {item}
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] p-4">
            <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-info-text)]">Network Summary</div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-center">
              <div className="rounded-lg bg-[var(--color-bg)] p-3" style={{ background: 'var(--color-surface)' }}><b>{nodes.length}</b><span className="mt-1 block text-[10px] text-[var(--color-text-muted)]">Nodes</span></div>
              <div className="rounded-lg bg-[var(--color-bg)] p-3" style={{ background: 'var(--color-surface)' }}><b>{nodes.length - 1}</b><span className="mt-1 block text-[10px] text-[var(--color-text-muted)]">Links</span></div>
            </div>
            {vehiclePlate && (
              <div className="mt-3 grid gap-2">
                <button type="button" className="btn btn-primary justify-center text-xs" onClick={() => setShowAddOwner(true)}>
                  <UserPlus size={14} /> Add Owner to Face Watchlist
                </button>
                {savedOwnerId && (
                  <button type="button" className="btn btn-ghost justify-center text-xs" onClick={() => navigate('/ai-analytics/watchlist/watchlist')}>
                    Open Face Watchlist
                  </button>
                )}
              </div>
            )}
          </section>
        </aside>
      </div>

      {showAddOwner && (
        <AddVehicleOwnerModal
          draft={ownerDraft}
          setDraft={setOwnerDraft}
          vehiclePlate={vehiclePlate}
          onClose={() => setShowAddOwner(false)}
          onSave={saveVehicleOwnerToWatchlist}
        />
      )}
    </main>
  );
}
