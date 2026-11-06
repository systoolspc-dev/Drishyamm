import { useState } from 'react';
import { DoorOpen } from 'lucide-react';

import RoomFilter from './components/room/RoomFilter';
import RoomCards from './components/room/RoomCards';
import RoomTimelines from './components/room/RoomTimelines';
import RoomTables from './components/room/RoomTables';
import { ROOMS } from './room-data';

// ─────────────────────────────────────────────────────────────────────────────
// Room Analytics — campus subpage (Prompt 6).
//
// "Every classroom has intelligence." Filter Building → Department → Room, then
// read the room: six cards (occupancy · capacity · attendance · utilization ·
// average stay · idle time), four timelines (occupancy / activity / lecture /
// teacher) and session tables (current · previous · history). FRONTEND-ONLY.
// ─────────────────────────────────────────────────────────────────────────────

export default function RoomAnalytics() {
  const [roomId, setRoomId] = useState(ROOMS[0].id);

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        {/* Title */}
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <DoorOpen className="h-5 w-5" strokeWidth={2} />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Room Analytics</h1>
            <p className="mt-1 text-small text-fg-muted">Every classroom has intelligence — occupancy, sessions and utilization per room.</p>
          </div>
        </div>

        <RoomFilter selectedId={roomId} onSelect={setRoomId} />

        <div className="space-y-4">
          <RoomCards roomId={roomId} />
          <RoomTimelines roomId={roomId} />
          <RoomTables roomId={roomId} />
        </div>
      </div>
    </div>
  );
}
