import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const SUSPECTS = [
  {
    face_id: 'FACE-00921',
    name: 'Ravi Sharma',
    face_status: 'red_list',
    match_status: 'matched',
    linked_weapon_ids: ['WEAP-PST-00017'],
    linked_incidents: ['WPN-002'],
    last_seen: '14:20:48',
    camera: 'CAM-12',
    location: 'Service Road',
    confidence: 91,
  },
  {
    face_id: null,
    name: 'Unknown Face #WPN-001',
    face_status: 'not_listed',
    match_status: 'unknown',
    linked_weapon_ids: ['WEAP-RFL-00042'],
    linked_incidents: ['WPN-001'],
    last_seen: '14:20:31',
    camera: 'CAM-04',
    location: 'Main Gate',
    confidence: 74,
  },
  {
    face_id: 'FACE-01108',
    name: 'Imran Khan',
    face_status: 'watchlisted',
    match_status: 'matched',
    linked_weapon_ids: ['WEAP-RFL-00043'],
    linked_incidents: ['WPN-004'],
    last_seen: '14:16:11',
    camera: 'CAM-03',
    location: 'Bus Bay',
    confidence: 87,
  },
  {
    face_id: null,
    name: 'Unknown Face #WPN-005',
    face_status: 'not_listed',
    match_status: 'unknown',
    linked_weapon_ids: ['WEAP-PST-00018'],
    linked_incidents: ['WPN-005'],
    last_seen: '14:14:33',
    camera: 'CAM-02',
    location: 'Back Gate',
    confidence: 69,
  },
  {
    face_id: 'FACE-01044',
    name: 'Karan Joshi',
    face_status: 'red_list',
    match_status: 'matched',
    linked_weapon_ids: ['WEAP-PST-00019'],
    linked_incidents: ['WPN-007'],
    last_seen: '13:55:18',
    camera: 'CAM-05',
    location: 'South Gate',
    confidence: 95,
  },
];

const STATUS = {
  red_list: { label: 'Red List', color: '#dc2626', bg: '#fef2f2' },
  watchlisted: { label: 'Watchlisted', color: '#2563eb', bg: '#eff6ff' },
  not_listed: { label: 'Not Listed', color: '#64748b', bg: '#f1f5f9' },
};

export default function BlacklistedSuspects() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const rows = useMemo(() => SUSPECTS
    .filter(item => filter === 'all' || item.match_status === filter || item.face_status === filter)
    .filter(item => {
      const q = search.toLowerCase();
      return !q || [
        item.name,
        item.face_id || '',
        item.camera,
        item.location,
        ...item.linked_weapon_ids,
        ...item.linked_incidents,
      ].some(value => value.toLowerCase().includes(q));
    }), [filter, search]);

  const openFace = (item) => {
    const params = new URLSearchParams({
      source: 'weapon',
      mode: 'add',
      incident: item.linked_incidents[0],
      weapon: item.linked_weapon_ids[0],
      face: item.face_id || 'unknown',
      image: '/weapon-demo.jpg',
      notes: `Captured at ${item.camera}, ${item.location}. Use this weapon-linked frame for Face Watchlist training and operator notes.`,
    });
    if (item.face_id) params.set('name', item.name);
    navigate(`/ai-analytics/watchlist/watchlist?${params.toString()}`);
  };

  return (
    <main className="weapon-suspects-page">
      <div className="weapon-watchlist-header">
        <div>
          <h2>Weapon-Linked Suspects</h2>
          <p>Known face matches and unknown faces connected to weapon incidents. Identity ownership stays in Face Watchlist.</p>
        </div>
      </div>

      <div className="weapon-suspects-stats">
        {[
          ['Known Matches', SUSPECTS.filter(item => item.match_status === 'matched').length, 'face'],
          ['Unknown Faces', SUSPECTS.filter(item => item.match_status === 'unknown').length, 'person_add'],
          ['Red List Links', SUSPECTS.filter(item => item.face_status === 'red_list').length, 'emergency'],
          ['Linked Weapons', new Set(SUSPECTS.flatMap(item => item.linked_weapon_ids)).size, 'report'],
        ].map(([label, value, icon]) => (
          <div key={label}>
            <span className="material-symbols-outlined">{icon}</span>
            <section>
              <em>{label}</em>
              <strong>{value}</strong>
            </section>
          </div>
        ))}
      </div>

      <section className="card weapon-card weapon-suspects-table-card">
        <div className="weapon-suspects-toolbar">
          <div>
            {[
              ['all', 'All'],
              ['matched', 'Face Linked'],
              ['unknown', 'Unknown Face'],
              ['red_list', 'Red List'],
              ['watchlisted', 'Watchlisted'],
            ].map(([id, label]) => (
              <button key={id} type="button" className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>
          <div className="search-box">
            <span className="material-symbols-outlined icon-sm">search</span>
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search face, weapon, incident..." />
          </div>
        </div>

        <div className="table-wrapper">
          <table className="data-table weapon-suspects-table">
            <thead>
              <tr>
                <th>Face Link</th>
                <th>Registry Status</th>
                <th>Linked Weapons</th>
                <th>Incidents</th>
                <th>Last Seen</th>
                <th>Confidence</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(item => {
                const tone = STATUS[item.face_status] || STATUS.not_listed;
                return (
                  <tr key={`${item.name}-${item.linked_incidents[0]}`}>
                    <td>
                      <div className="weapon-suspect-face-cell">
                        <span className="material-symbols-outlined">{item.face_id ? 'face' : 'person_add'}</span>
                        <strong>{item.name}</strong>
                        <em>{item.face_id || 'Unknown face intake'}</em>
                      </div>
                    </td>
                    <td><span className="weapon-registry-chip" style={{ color: tone.color, background: tone.bg, borderColor: 'transparent' }}>{tone.label}</span></td>
                    <td className="mono">{item.linked_weapon_ids.join(', ')}</td>
                    <td className="mono">{item.linked_incidents.join(', ')}</td>
                    <td>{item.camera} / {item.location} / {item.last_seen}</td>
                    <td className="mono" style={{ fontWeight: 900, color: item.confidence > 85 ? '#dc2626' : '#b45309' }}>{item.confidence}%</td>
                    <td>
                      <div className="weapon-registry-actions">
                        <button type="button" title="Send capture to Face Watchlist intake" onClick={() => openFace(item)}>
                          <span className="material-symbols-outlined">{item.face_id ? 'face' : 'person_add'}</span>
                        </button>
                        <button type="button" title="Relationship Graph" onClick={() => navigate(`/ai-analytics/watchlist/relationship?source=weapon&face=${item.face_id || ''}&incident=${item.linked_incidents[0]}`)}>
                          <span className="material-symbols-outlined">share</span>
                        </button>
                        <button type="button" title="REID Journey" onClick={() => navigate(`/ai-analytics/watchlist/reid/${item.face_id || item.linked_incidents[0]}`)}>
                          <span className="material-symbols-outlined">navigation</span>
                        </button>
                        <button type="button" title="Weapon Journey" onClick={() => navigate(`/ai-analytics/weapon/journey/${item.linked_weapon_ids[0]}`)}>
                          <span className="material-symbols-outlined">route</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
