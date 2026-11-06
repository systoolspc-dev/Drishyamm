// One tile of a wall — the same tile on the full-screen wall and on the
// in-app Monitor Wall view.
//
// A tile is live when its recorder has budget for it (see liveBudget in
// model.js). Past that budget it shows a refreshing still with a "Preview"
// badge instead of a player, so a 3 × 3 of one NVR's cameras never asks that
// NVR for 18 streams — the thing that jammed the office recorder four times.

import { VideoOff, Volume2 } from 'lucide-react';
import DirectStreamPlayer from '@/core/players/DirectStreamPlayer';
import { playerQuality } from '@/core/lib/utils';
import { useSnapshot } from '@/core/hooks/useSnapshot';
import { NVR_PULL_LIMIT, lastSeen, pad2 } from './model';

export function WallTile({ slot, monitorId, camera, still, focused, audible, onFocus, onExpand }) {
  if (!monitorId) {
    return <div className="grid place-items-center bg-neutral-950 text-body text-white/25">Slot {pad2(slot + 1)} · no camera</div>;
  }
  if (!camera) {
    return <div className="grid place-items-center bg-neutral-950 text-body text-white/40">Camera not available</div>;
  }
  const online = camera.status === 'online';
  const preview = online && still;
  const title = preview
    ? `${camera.name} — preview still: its recorder is already serving ${NVR_PULL_LIMIT} streams. Double-click to watch it live.`
    : `${camera.name} — click to hear, double-click to fill the screen`;
  return (
    <div
      onClick={onFocus}
      onDoubleClick={onExpand}
      title={title}
      className={`relative cursor-pointer overflow-hidden ${online ? 'bg-neutral-950' : 'bg-linear-to-br from-danger/45 via-danger/15 to-neutral-950'}`}
    >
      {!online ? (
        <OfflineBody camera={camera} />
      ) : preview ? (
        <StillBody monitorId={monitorId} />
      ) : (
        <DirectStreamPlayer
          monitorId={monitorId}
          mode="webrtc"
          quality={playerQuality(camera, 'low')}
          muted={!audible}
          controls={false}
          qualityControl={false}
          protocolBadge={false}
          aiOverlay={false}
          digitalZoom={false}
          fit="cover"
          className="absolute inset-0 h-full w-full"
        />
      )}
      {focused && <span aria-hidden className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_3px] shadow-brand" />}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-linear-to-t from-black/70 to-transparent px-3.5 pb-2.5 pt-8">
        <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${online ? 'bg-success' : 'bg-danger'}`} />
        <span className="truncate text-heading text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">{camera.name}</span>
        {audible && <Volume2 className="h-4 w-4 shrink-0 text-brand" aria-label="Sound on" />}
        {preview && (
          <span className="ml-auto shrink-0 rounded border border-white/20 bg-black/50 px-1.5 py-0.5 text-caption font-semibold text-white/80">
            Preview
          </span>
        )}
      </div>
    </div>
  );
}

// A still that refreshes on the snapshot cache's cadence — the picture a
// camera shows when its recorder cannot take one more stream.
function StillBody({ monitorId }) {
  const snap = useSnapshot(monitorId);
  return (
    <div className="absolute inset-0 bg-neutral-950">
      {snap?.url
        ? <img src={snap.url} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
        : <div className="absolute inset-0 animate-pulse bg-neutral-900" />}
    </div>
  );
}

export function OfflineBody({ camera, large }) {
  const seen = lastSeen(camera.lastSeenAt);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 pb-6 text-center">
      <VideoOff className={`${large ? 'h-12 w-12' : 'h-8 w-8'} mb-1 text-danger`} />
      <span className="text-small font-bold uppercase tracking-[0.14em] text-danger">Offline</span>
      <span className="text-body tabular-nums text-white/60">{seen ? `Last seen ${seen}` : 'Not seen recently'}</span>
    </div>
  );
}
