import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { anprDetections, anprMockData, blacklistedVehicles } from '../../data/ANPR';

const seedProfiles = [
  ...blacklistedVehicles.map((vehicle, index) => ({
    ...vehicle,
    evidenceImage: anprMockData.liveFeed.find((item) => item.plate === vehicle.plate)?.poster || anprMockData.liveFeed[index % anprMockData.liveFeed.length]?.poster,
    evidenceVideo: anprMockData.liveFeed.find((item) => item.plate === vehicle.plate)?.video || anprMockData.liveFeed[index % anprMockData.liveFeed.length]?.video,
    source: 'Watchlist',
    type: ['Sedan', 'Bike', 'SUV', 'Utility', 'Van'][index] || 'Vehicle',
    ownerName: ['Unknown', 'Unknown', 'Amit Kumar', 'Unknown', 'City Shuttle Operator'][index] || 'Unknown',
    ownerPhoto: '',
    lastSeen: ['Main Gate / CAM-01 / 14:22', 'Bus Bay / CAM-04 / 14:18', 'Parking Area / CAM-03 / 14:21', 'East Entry / CAM-05 / 13:58', 'South Gate / CAM-06 / 14:17'][index],
    notes: ['Stolen vehicle alert. Inspect route before interception.', 'Wanted association. Avoid roadside confrontation.', 'Open traffic warrant with repeated parking visits.', 'Suspected trafficking route through loading bay.', 'Fine threshold exceeded. Notify enforcement desk.'][index],
    risk: vehicle.riskLevel === 'critical' ? 'Critical' : 'High',
  })),
  ...anprDetections.map((vehicle) => ({
    id: vehicle.id,
    plate: vehicle.plate,
    evidenceImage: anprMockData.liveFeed.find((item) => item.plate === vehicle.plate)?.poster,
    evidenceVideo: anprMockData.liveFeed.find((item) => item.plate === vehicle.plate)?.video,
    reason: vehicle.status === 'clear' ? 'Historical ANPR detection' : `${vehicle.status} ANPR detection`,
    riskLevel: vehicle.status === 'blacklisted' ? 'critical' : vehicle.status === 'clear' ? 'low' : 'warning',
    addedDate: vehicle.timestamp.split(' ')[0],
    make: vehicle.make,
    color: vehicle.color,
    category: vehicle.status,
    source: 'Detected profile',
    type: vehicle.vehicleType,
    ownerName: 'Unknown',
    ownerPhoto: '',
    lastSeen: `${vehicle.location} / ${vehicle.camera} / ${vehicle.timestamp.split(' ')[1]}`,
    notes: `${Math.round(vehicle.confidence * 100)}% OCR confidence / ${vehicle.speed} km/h`,
    risk: vehicle.status === 'blacklisted' ? 'Critical' : vehicle.status === 'clear' ? 'Normal' : 'High',
  })),
];

const emptyDraft = {
  plate: '',
  make: '',
  color: '',
  type: '',
  ownerName: '',
  ownerPhoto: '',
  reason: '',
  category: 'Police Interest',
  risk: 'High',
  notes: '',
};

function isDateInRange(value, from, to) {
  if (!value) return !from && !to;
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

function RiskBadge({ risk }) {
  return <span className={`anpr-risk ${String(risk).toLowerCase()}`}>{risk}</span>;
}

const metricCards = [
  { label: 'Vehicles Detected', value: '1,842', delta: '+18% vs yesterday', icon: 'directions_car', tone: 'info' },
  { label: 'Unique Vehicles', value: '1,240', delta: '+16% vs yesterday', icon: 'car_rental', tone: 'violet' },
  { label: 'Blacklisted', value: '7', delta: '+27% vs yesterday', icon: 'block', tone: 'danger' },
  { label: 'Entry Count', value: '950', delta: '+14% vs yesterday', icon: 'login', tone: 'success' },
  { label: 'Exit Count', value: '892', delta: '+13% vs yesterday', icon: 'logout', tone: 'navy' },
];

const summaryCards = [
  { label: 'Blacklisted', value: anprMockData.watchlistSummary.blacklisted, icon: 'block', tone: 'danger' },
  { label: 'Stolen', value: anprMockData.watchlistSummary.stolen, icon: 'car_crash', tone: 'danger' },
  { label: 'VIP', value: anprMockData.watchlistSummary.vip, icon: 'star', tone: 'violet' },
  { label: 'Police Interest', value: anprMockData.watchlistSummary.policeInterest, icon: 'verified_user', tone: 'info' },
];

function VehicleModal({ vehicle, onClose, onJourney, onRelationship }) {
  if (!vehicle) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="modal-box anpr-vehicle-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>{vehicle.plate}</h2>
            <p>{vehicle.make} / {vehicle.color} / {vehicle.type}</p>
          </div>
          <button className="icon-btn btn btn-ghost" onClick={onClose} aria-label="Close vehicle profile">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="modal-body anpr-profile-body">
          {vehicle.evidenceImage && (
            <div className="anpr-modal-footage">
              {vehicle.evidenceVideo ? (
                <video src={vehicle.evidenceVideo} poster={vehicle.evidenceImage} controls muted playsInline preload="metadata" />
              ) : (
                <img
                  src={vehicle.evidenceImage}
                  alt={`${vehicle.plate} ANPR footage`}
                  loading="lazy"
                  decoding="async"
                  width={1280}
                  height={720}
                />
              )}
              <span className="mono">{vehicle.lastSeen}</span>
            </div>
          )}
          <div className="anpr-owner-card">
            <div className="anpr-owner-photo">
              {vehicle.ownerPhoto ? <img src={vehicle.ownerPhoto} alt={vehicle.ownerName} /> : <span className="material-symbols-outlined">person</span>}
            </div>
            <div>
              <span>Registered owner</span>
              <strong>{vehicle.ownerName || 'Unknown'}</strong>
              <small>{vehicle.source} / {vehicle.category}</small>
            </div>
          </div>
          <div className="anpr-profile-grid">
            {[
              ['Risk', vehicle.risk],
              ['Reason', vehicle.reason],
              ['Last Seen', vehicle.lastSeen],
              ['Added / Detected', vehicle.addedDate],
              ['Owner Name', vehicle.ownerName || 'Unknown'],
              ['Notes', vehicle.notes],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onRelationship}>
            <span className="material-symbols-outlined icon-sm">hub</span>
            Relationship Graph
          </button>
          <button className="btn btn-primary" onClick={onJourney}>
            <span className="material-symbols-outlined icon-sm">route</span>
            Open Journey
          </button>
        </div>
      </section>
    </div>
  );
}

function AddVehicleModal({ draft, setDraft, onClose, onSave }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="modal-box anpr-vehicle-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Add Vehicle Profile</h2>
            <p>Add a detected or watchlisted vehicle with optional owner identity.</p>
          </div>
          <button className="icon-btn btn btn-ghost" onClick={onClose} aria-label="Close add vehicle">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="modal-body">
          <div className="anpr-form-grid">
            {[
              ['plate', 'Plate number'],
              ['make', 'Make / model'],
              ['color', 'Color'],
              ['type', 'Vehicle type'],
              ['ownerName', 'Owner name if known'],
              ['ownerPhoto', 'Owner photo URL if available'],
              ['reason', 'Watch reason'],
              ['notes', 'Operational notes'],
            ].map(([key, label]) => (
              <label key={key} className={key === 'notes' ? 'wide' : ''}>
                <span>{label}</span>
                {key === 'notes' ? (
                  <textarea value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
                ) : (
                  <input value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
                )}
              </label>
            ))}
            <label>
              <span>Category</span>
              <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
                <option>Police Interest</option>
                <option>Stolen</option>
                <option>Traffic Warrant</option>
                <option>VIP</option>
                <option>Detected profile</option>
              </select>
            </label>
            <label>
              <span>Risk</span>
              <select value={draft.risk} onChange={(event) => setDraft({ ...draft, risk: event.target.value })}>
                <option>Critical</option>
                <option>High</option>
                <option>Normal</option>
              </select>
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave}>Add Vehicle</button>
        </div>
      </section>
    </div>
  );
}

export default function VehicleWatchlistManagement() {
  const navigate = useNavigate();
  const [vehicles, setVehicles] = useState(seedProfiles);
  const [search, setSearch] = useState('');
  const [risk, setRisk] = useState('All');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showSummary, setShowSummary] = useState(true);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return vehicles.filter((vehicle) => {
      if (risk !== 'All' && vehicle.risk !== risk) return false;
      if (!isDateInRange(vehicle.addedDate, dateFrom, dateTo)) return false;
      if (!query) return true;
      return [vehicle.plate, vehicle.make, vehicle.color, vehicle.type, vehicle.risk, vehicle.ownerName, vehicle.lastSeen, vehicle.notes, vehicle.reason]
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [dateFrom, dateTo, risk, search, vehicles]);

  const saveDraft = () => {
    const plate = draft.plate.trim() || `NEW-${vehicles.length + 1}`;
    setVehicles([
      {
        id: `MAN-${Date.now()}`,
        plate,
        make: draft.make || 'Unknown make',
        color: draft.color || 'Unknown',
        type: draft.type || 'Vehicle',
        ownerName: draft.ownerName || 'Unknown',
        ownerPhoto: draft.ownerPhoto,
        reason: draft.reason || 'Manual watchlist entry',
        category: draft.category,
        source: 'Manual entry',
        risk: draft.risk,
        riskLevel: draft.risk.toLowerCase(),
        addedDate: new Date().toISOString().slice(0, 10),
        lastSeen: 'Awaiting first ANPR hit',
        notes: draft.notes || 'No operational notes added.',
        evidenceImage: anprMockData.liveFeed[0]?.poster,
        evidenceVideo: anprMockData.liveFeed[0]?.video,
      },
      ...vehicles,
    ]);
    setDraft(emptyDraft);
    setAdding(false);
  };

  return (
    <main className="anpr-watchlist-page">
      <div className="anpr-section-head">
        <div>
          <h2>Vehicle Watchlist</h2>
          <p>All detected vehicle profiles retained for investigation and future policy-driven retention.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <span className="material-symbols-outlined icon-sm">add</span>
          Add Vehicle
        </button>
      </div>

      <section className="anpr-watchlist-intel">
        <div className="anpr-watch-metrics">
          {metricCards.map((metric) => (
            <article className={`anpr-watch-metric ${metric.tone}`} key={metric.label}>
              <span className="material-symbols-outlined">{metric.icon}</span>
              <div>
                <small>{metric.label}</small>
                <strong>{metric.value}</strong>
                <em>{metric.delta}</em>
              </div>
            </article>
          ))}
        </div>

        <aside className={`card anpr-watch-summary ${showSummary ? '' : 'is-collapsed'}`}>
          <div className="anpr-watch-summary-head">
            <div>
              <h3>Watchlist Summary</h3>
              <p>Category counts for retained vehicle profiles.</p>
            </div>
            <button className="btn btn-ghost icon-btn" onClick={() => setShowSummary(!showSummary)} aria-label="Toggle watchlist summary">
              <span className="material-symbols-outlined">{showSummary ? 'visibility_off' : 'visibility'}</span>
            </button>
          </div>
          {showSummary && (
            <div className="anpr-watch-summary-grid">
              {summaryCards.map((item) => (
                <div className={`anpr-watch-summary-card ${item.tone}`} key={item.label}>
                  <span className="material-symbols-outlined">{item.icon}</span>
                  <div>
                    <strong>{item.value}</strong>
                    <small>{item.label}</small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </section>

      <div className="anpr-watch-toolbar">
        <label className="search-box">
          <span className="material-symbols-outlined icon-sm">search</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search plate, owner, make, location, notes..." />
        </label>
        <select value={risk} onChange={(event) => setRisk(event.target.value)}>
          <option>All</option>
          <option>Critical</option>
          <option>High</option>
          <option>Normal</option>
        </select>
        <label className="anpr-date-filter">
          <span>From</span>
          <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </label>
        <label className="anpr-date-filter">
          <span>To</span>
          <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </label>
        {(dateFrom || dateTo) && (
          <button className="btn btn-ghost" type="button" onClick={() => { setDateFrom(''); setDateTo(''); }}>
            Clear Dates
          </button>
        )}
      </div>

      <section className="card anpr-watch-table">
        <table className="data-table">
          <thead>
            <tr>
              <th>Vehicle</th>
              <th>Risk</th>
              <th>Owner</th>
              <th>Retained Date</th>
              <th>Last Seen</th>
              <th>Source</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((vehicle) => (
              <tr key={vehicle.id}>
                <td>
                  <strong className="mono">{vehicle.plate}</strong>
                  <small>{vehicle.make} / {vehicle.color} / {vehicle.type}</small>
                </td>
                <td><RiskBadge risk={vehicle.risk} /></td>
                <td>{vehicle.ownerName || 'Unknown'}</td>
                <td>{vehicle.addedDate}</td>
                <td>{vehicle.lastSeen}</td>
                <td>{vehicle.source}</td>
                <td>
                  <div className="anpr-inline-actions">
                    <button className="btn btn-ghost" onClick={() => setSelected(vehicle)}>Profile</button>
                    <button className="btn btn-primary" onClick={() => navigate(`/ai-analytics/vehicle/journey?plate=${vehicle.plate}`)}>Journey</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <VehicleModal
        vehicle={selected}
        onClose={() => setSelected(null)}
        onJourney={() => navigate(`/ai-analytics/vehicle/journey?plate=${selected?.plate}`)}
        onRelationship={() => navigate(`/ai-analytics/vehicle/relationship?plate=${selected?.plate}`)}
      />
      {adding && (
        <AddVehicleModal
          draft={draft}
          setDraft={setDraft}
          onClose={() => setAdding(false)}
          onSave={saveDraft}
        />
      )}
    </main>
  );
}
