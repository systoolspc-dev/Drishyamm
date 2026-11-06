/**
 * ReportBody.jsx — the report document itself.
 *
 * The cards a report is made of, in the order its PDF puts them. It lives
 * apart from any one screen because three things now render the same
 * document: the saved-report route, the live-preview route, and the preview
 * dialog on the hub. When they each owned a copy of this switch, a card added
 * for one of them was a card the other two quietly lacked.
 *
 * Four tiles, then cards: a table of what needs a person, one small chart
 * beside the breakdown, and a table of cameras. Each type picks its own.
 */

import {
  ActivityByDay, Breakdown, Cameras, CameraStatusTable, DailyPeak, Incidents, Notes,
  OccupancyTable, PeopleTable, ReportFootnote, SummaryTiles, ZonesTable,
} from './ReportSections';

/** Two cards side by side on wide screens, equal height. */
const Pair = ({ children }) => <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{children}</div>;

/** The cards a report type is made of, top to bottom. */
function bodyFor(report, { onOpenClip }) {
  switch (report.type) {
    case 'face':
      return (
        <>
          {report.incidents?.length > 0 && <Incidents report={report} onOpenClip={onOpenClip} />}
          <PeopleTable report={report} />
          <Pair>
            <ActivityByDay report={report} unit="face events" />
            <Breakdown report={report} title="Face events" />
          </Pair>
          <Cameras report={report} title="Cameras with most faces" countTitle="Faces" limit={5} />
        </>
      );
    case 'restricted_area':
      return (
        <>
          <ZonesTable report={report} />
          <Incidents report={report} onOpenClip={onOpenClip} empty="No restricted-zone entry was recorded in this period." />
          <Pair>
            <ActivityByDay report={report} />
            <Breakdown report={report} />
          </Pair>
          <Cameras report={report} title="Cameras with most entries" countTitle="Detections" />
        </>
      );
    case 'occupancy':
      return (
        <>
          <OccupancyTable report={report} />
          <Incidents report={report} title="Capacity incidents" onOpenClip={onOpenClip} empty="No occupancy threshold or crowding event was raised in this period." />
          <Pair>
            {report.occupancy?.daily?.length ? <DailyPeak report={report} /> : <ActivityByDay report={report} />}
            <Breakdown report={report} />
          </Pair>
        </>
      );
    case 'camera_health':
    case 'recording':
      return <CameraStatusTable report={report} />;
    case 'incident':
      return (
        <>
          <Incidents report={report} title="Incidents" onOpenClip={onOpenClip} empty="No incident was recorded in this period." />
          <Pair>
            <ActivityByDay report={report} title="Incidents by day" />
            <Breakdown report={report} title="What the incidents were" excludeRoutine />
          </Pair>
          {/* Per-camera totals are event rows, routine traffic included — the column says so. */}
          <Cameras report={report} title="Where they happened" limit={4} />
        </>
      );
    default:
      return (
        <>
          <Incidents report={report} onOpenClip={onOpenClip} />
          <Pair>
            <ActivityByDay report={report} />
            <Breakdown report={report} />
          </Pair>
          <Cameras report={report} />
        </>
      );
  }
}

export function ReportBody({ report, onOpenClip, className = 'pb-6' }) {
  if (!report) return null;
  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      <Notes report={report} />
      <SummaryTiles report={report} />
      {bodyFor(report, { onOpenClip })}
      <ReportFootnote report={report} />
    </div>
  );
}

export default ReportBody;
