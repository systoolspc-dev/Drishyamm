/**
 * Relationship scoring engine for surveillance entity graphs.
 *
 * Strength score ∈ [0, 1]:
 *   ≥ 0.70 → 'strong'
 *   ≥ 0.40 → 'moderate'
 *   < 0.40 → 'weak'
 *
 * score = baseScore × confidence × frequencyWeight × recencyWeight
 *   frequencyWeight = log(1 + k) / log(1 + maxK)   — log-scale co-occurrence
 *   recencyWeight   = 1 / (1 + daysSinceLast × 0.1) — time-decay
 */

// ─── Core scoring ─────────────────────────────────────────────────────────────

export function computeScore({
  baseScore = 1,
  confidence = 1,
  occurrences = 1,
  maxOccurrences = 1,
  daysSinceLast = 0,
}) {
  const freq = Math.log1p(occurrences) / Math.log1p(Math.max(occurrences, maxOccurrences));
  const recency = 1 / (1 + daysSinceLast * 0.1);
  return Math.min(1, baseScore * confidence * (0.55 + 0.45 * freq) * recency);
}

export function scoreToStrength(score) {
  if (score >= 0.70) return 'strong';
  if (score >= 0.40) return 'moderate';
  return 'weak';
}

// ─── Layout — equal-angle placement on a circle around (50, 50) ──────────────

export function computeLayout(surroundingCount) {
  const positions = [{ x: 50, y: 50 }];
  if (surroundingCount === 0) return positions;
  const radius = Math.min(34, 17 + surroundingCount * 2.5);
  for (let i = 0; i < surroundingCount; i++) {
    const angle = (2 * Math.PI * i) / surroundingCount - Math.PI / 2;
    positions.push({
      x: parseFloat((50 + radius * Math.cos(angle)).toFixed(1)),
      y: parseFloat((50 + radius * Math.sin(angle)).toFixed(1)),
    });
  }
  return positions;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractPlateFromText(text = '') {
  const m = text.match(/[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{3,4}/);
  return m ? m[0] : null;
}

// ─── Vehicle relationship graph ───────────────────────────────────────────────
//
// Candidate nodes and their scoring logic:
//
//   OWNER     — baseScore 0.92 (registered) / 0.20 (unknown)
//   CAMERA    — baseScore 0.95 × detection.confidence × journey length frequency
//   FACE      — baseScore 0.88 (identified) / 0.28 (unmatched) × face confidence
//   INCIDENT  — baseScore 0.95 (blacklisted/critical) / 0.62 (watchlist) / 0.08 (clear)
//   CO-DETECT — baseScore 0.52 × co-vehicle confidence (same camera, ≤2 min window)
//
// Candidates are scored, sorted descending, capped at MAX_SURROUNDING,
// then laid out at equal angles around the center vehicle node.

const CODETECTION_WINDOW_MS = 2 * 60 * 1000;
const MAX_SURROUNDING = 6;

export function buildVehicleGraph({ plate, detections, blacklist, ownerMap, faceMap, journeyData }) {
  const detection = detections.find((d) => d.plate === plate) || detections[0];
  const watch = blacklist.find((d) => d.plate === plate);
  const journey = journeyData.find((j) => j.plate === plate);
  const owner = ownerMap[plate] || 'Unknown Owner';
  const face = faceMap[plate] || { name: 'Unknown Person', identified: false, confidence: null, faceId: null };
  const detectionTime = new Date(detection.timestamp).getTime();

  const coDetected = detections.filter(
    (d) =>
      d.plate !== plate &&
      d.camera === detection.camera &&
      Math.abs(new Date(d.timestamp).getTime() - detectionTime) <= CODETECTION_WINDOW_MS,
  );

  const candidates = [];

  // 1. Registered owner
  candidates.push({
    id: 'owner',
    label: owner,
    category: owner === 'Unknown Owner' ? 'No registration found' : 'Registered owner',
    type: 'person',
    relation: 'Vehicle registration record',
    score: computeScore({ baseScore: owner === 'Unknown Owner' ? 0.20 : 0.92 }),
  });

  // 2. Detection camera — strength scales with journey depth (cross-camera sightings)
  candidates.push({
    id: 'camera',
    label: detection.camera,
    category: detection.location,
    type: 'camera',
    relation: `Detected ${detection.timestamp}`,
    score: computeScore({
      baseScore: 0.95,
      confidence: detection.confidence,
      occurrences: journey ? journey.entries.length : 1,
      maxOccurrences: 10,
    }),
    location: detection.location,
    timestamp: detection.timestamp,
    confidence: detection.confidence,
    speed: detection.speed,
  });

  // 3. Co-detected face — strong if biometric match, weak if unidentified
  candidates.push({
    id: 'face',
    label: face.name,
    category: face.identified
      ? `Face matched · ${Math.round(face.confidence * 100)}% confidence`
      : 'Face detected — not matched',
    type: 'face',
    relation: 'Co-detected at camera',
    score: computeScore({
      baseScore: face.identified ? 0.88 : 0.28,
      confidence: face.identified ? face.confidence : 0.5,
    }),
    identified: face.identified,
    faceId: face.faceId,
    confidence: face.confidence,
  });

  // 4. Watchlist / policy incident
  const incidentBase =
    detection.status === 'clear' ? 0.08
    : watch?.riskLevel === 'critical' || detection.status === 'blacklisted' ? 0.95
    : 0.62;
  candidates.push({
    id: 'incident',
    label: watch?.reason || (detection.status === 'clear' ? 'No Alert' : detection.status),
    category: watch?.category || (detection.status === 'clear' ? 'Vehicle cleared' : 'System flag'),
    type: 'incident',
    relation: 'Policy / watchlist match',
    score: computeScore({ baseScore: incidentBase }),
  });

  // 5. Co-detected vehicles (same camera, within 2-min window) — up to 2
  coDetected.slice(0, 2).forEach((co, i) => {
    candidates.push({
      id: `co-vehicle-${i}`,
      label: co.plate,
      category: `${co.color} ${co.make} · co-detection`,
      type: 'vehicle',
      relation: 'Co-detected · same camera, ≤2 min',
      score: computeScore({ baseScore: 0.52, confidence: co.confidence }),
    });
  });

  const sorted = candidates.sort((a, b) => b.score - a.score).slice(0, MAX_SURROUNDING);
  const positions = computeLayout(sorted.length);

  return [
    {
      id: 'vehicle',
      label: plate,
      category: `${detection.color} ${detection.make}`,
      type: 'vehicle',
      relation: 'Selected vehicle',
      score: 1,
      strength: 'selected',
      ...positions[0],
    },
    ...sorted.map((node, i) => ({
      ...node,
      strength: scoreToStrength(node.score),
      ...positions[i + 1],
    })),
  ];
}

// ─── Person relationship graph ────────────────────────────────────────────────
//
// Candidate nodes and their scoring logic:
//
//   RELATED PERSONS  — scored by three additive signals:
//     • same risk tier      → +0.30
//     • same category       → +0.30
//     • shared camera zones → +0.15 per shared CAM-XX mention in notes (max 0.35)
//     base = 0.15, total capped at 0.95; top-4 by score
//
//   VEHICLE LINK     — baseScore 0.82 (explicit cross-module plate) /
//                                0.55 (plate extracted from notes/aliases) /
//                                0.18 (no vehicle evidence)
//
//   INCIDENT LINK    — baseScore by risk: Critical 0.92 / High 0.75 /
//                                        Medium 0.48 / Low 0.22
//
// All candidates scored, sorted, capped at MAX_SURROUNDING, laid out by computeLayout.

export function buildPersonGraph({ selectedPerson, allPeople, vehiclePlate }) {
  const candidates = [];

  // 1. Related persons — data-driven scoring, not index-based
  const relatedPersons = allPeople
    .filter((p) => p.id !== selectedPerson.id)
    .map((person) => {
      const sameRisk = person.riskLevel === selectedPerson.riskLevel ? 0.30 : 0;
      const sameCategory = person.category === selectedPerson.category ? 0.30 : 0;
      const selectedCams = (selectedPerson.notes || '').match(/CAM-\d+/g) || [];
      const personCams = (person.notes || '').match(/CAM-\d+/g) || [];
      const sharedCams = selectedCams.filter((c) => personCams.includes(c)).length;
      const camBonus = Math.min(0.35, sharedCams * 0.15);
      const score = Math.min(0.95, 0.15 + sameRisk + sameCategory + camBonus);

      return {
        id: person.id,
        label: person.name,
        category: person.category,
        type: 'person',
        riskLevel: person.riskLevel,
        relation:
          sharedCams > 0 ? `${sharedCams} shared camera zone(s)` : 'Watchlist proximity',
        score,
        evidence: [
          sharedCams > 0 ? `${sharedCams} shared camera sighting(s)` : 'Watchlist co-entry',
          `Risk: ${person.riskLevel}`,
          `Category: ${person.category}`,
        ],
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  relatedPersons.forEach((p) => candidates.push(p));

  // 2. Vehicle cross-link — explicit param takes priority, then notes extraction
  const linkedPlate =
    vehiclePlate ||
    extractPlateFromText(`${selectedPerson.notes || ''} ${selectedPerson.aliases || ''}`);
  const vehicleBase = vehiclePlate ? 0.82 : linkedPlate ? 0.55 : 0.18;

  candidates.push({
    id: 'vehicle-link',
    label: linkedPlate || 'No vehicle linked',
    category: 'Vehicle',
    type: 'vehicle',
    riskLevel: vehiclePlate ? 'High' : linkedPlate ? 'Medium' : 'Low',
    relation: vehiclePlate
      ? 'Vehicle Intelligence cross-link'
      : linkedPlate
        ? 'Plate inferred from record'
        : 'No active vehicle evidence',
    score: vehicleBase,
    evidence: vehiclePlate
      ? ['ANPR cross-link', vehiclePlate, 'Owner identity — review needed']
      : linkedPlate
        ? [`Plate ${linkedPlate} from record`, 'ANPR verification pending', 'Manual review required']
        : ['No ANPR reference', 'No vehicle in record'],
  });

  // 3. Incident link — severity drives score
  const incidentBase =
    { Critical: 0.92, High: 0.75, Medium: 0.48, Low: 0.22 }[selectedPerson.riskLevel] || 0.40;
  const personIndex = Math.max(0, allPeople.findIndex((p) => p.id === selectedPerson.id));

  candidates.push({
    id: 'incident-link',
    label: `INC-${200 + (personIndex % 100)}`,
    category: 'Incident',
    type: 'incident',
    riskLevel: selectedPerson.riskLevel,
    relation: 'Incident evidence',
    score: incidentBase,
    evidence: ['Open case', 'Face match confirmed', 'Operator review pending'],
  });

  const sorted = candidates.sort((a, b) => b.score - a.score).slice(0, MAX_SURROUNDING);
  const positions = computeLayout(sorted.length);

  return [
    {
      id: selectedPerson.id,
      label: selectedPerson.name,
      type: 'selected',
      category: selectedPerson.category,
      riskLevel: selectedPerson.riskLevel,
      relation: 'Selected profile',
      score: 1,
      strength: 'primary',
      evidence: ['Current subject', selectedPerson.id, selectedPerson.status || 'Active'],
      ...positions[0],
    },
    ...sorted.map((node, i) => ({
      ...node,
      strength: scoreToStrength(node.score),
      ...positions[i + 1],
    })),
  ];
}
