/**
 * The one row above the canvas: WHERE this zone is drawn, and WHAT it is.
 *
 *   📹 Camera  ›  [ zone name ] [ floor ] [ profile ] [ ⋯ ]
 *
 * Picking a camera or a zone, and adding one, happen in the rail and only
 * there. This row used to repeat both as dropdowns, with its own "+ New
 * zone", so every choice had two controls and a camera with one zone showed
 * the same name three times. Now the camera is a label (a small switcher only
 * when the zone spans several cameras, to move between its views) and the
 * zone is its name, edited in place.
 *
 * The ⋯ menu keeps the rare, easy-to-get-wrong multi-camera actions: span
 * another camera, make a view primary (where intrusion rules run), drop one.
 */
import {
  ChevronRight, Ellipsis, Plus, Star, Video, X,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';

const status = (c) => (!c ? '' : !c.counting ? 'not counting yet' : c.offline ? 'offline' : '');

export default function CanvasBar({
  cameras, zoneCameras, activeCam, onCam, onAddCamera, onRemoveCamera, onMakePrimary,
  name, onName, color, children,
}) {
  const cam = (m) => cameras.find((c) => c.id === m);
  const nameOf = (m) => cam(m)?.label || m;
  const addable = cameras.filter((c) => !zoneCameras.includes(c.id));
  const spans = zoneCameras.length > 1;
  const note = status(cam(activeCam));

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      {/* Where: the camera, as a label. */}
      <span className="flex min-w-0 max-w-full items-center gap-1.5 text-body font-semibold text-fg-secondary">
        <Video className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
        {spans ? (
          <select
            aria-label="View of this zone"
            className="min-w-0 max-w-[14rem] rounded-md border border-line bg-surface py-1 pl-1.5 pr-6 text-body font-semibold text-fg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
            onChange={(e) => onCam(e.target.value)}
            title="This zone spans several cameras — pick the view to draw on"
            value={activeCam}
          >
            {zoneCameras.map((m, i) => <option key={m} value={m}>{nameOf(m)}{i === 0 ? ' ★' : ''}</option>)}
          </select>
        ) : (
          <span className="min-w-0 truncate" title={nameOf(activeCam)}>{nameOf(activeCam)}</span>
        )}
        {note ? <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small font-semibold text-fg-subtle">{note}</span> : null}
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-disabled" strokeWidth={2.5} />
      </span>

      {/* What: the zone, named in place, then what kind of zone it is. */}
      <div className="flex min-w-[14rem] flex-1 flex-wrap items-center gap-2">
        <label className="relative flex min-w-[10rem] flex-1 items-center" htmlFor="z-name">
          <span className="sr-only">Zone name</span>
          <span
            className="pointer-events-none absolute left-3 h-2.5 w-2.5 rounded-sm ring-1 ring-black/20"
            style={{ background: color || 'var(--line-strong)' }}
          />
          <input
            className="w-full rounded-lg border border-line bg-surface py-1.5 pl-8 pr-3 text-body font-semibold text-fg placeholder:font-normal placeholder:text-fg-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
            id="z-name"
            onChange={(e) => onName(e.target.value)}
            placeholder="Name this zone — e.g. Reception queue"
            value={name}
          />
        </label>
        {children}

        {addable.length || spans ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="Cameras for this zone"
                className="inline-flex h-[34px] shrink-0 items-center gap-1 rounded-lg border border-line bg-surface px-2 text-body font-semibold text-fg-muted transition hover:border-brand/50 hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                title="Cameras for this zone"
                type="button"
              >
                <Ellipsis className="h-3.5 w-3.5" strokeWidth={2.25} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[calc(var(--app-vh)*0.6)] max-w-[20rem] overflow-y-auto">
              {spans ? (
                <>
                  <DropdownMenuLabel className="text-body">This zone&apos;s cameras</DropdownMenuLabel>
                  {zoneCameras.map((m, i) => (
                    <div className="flex items-center gap-1 px-1" key={m}>
                      <DropdownMenuItem
                        className="min-w-0 flex-1"
                        disabled={i === 0}
                        onSelect={() => onMakePrimary(m)}
                        title={i === 0 ? 'Primary view — intrusion rules run on this camera' : 'Make primary'}
                      >
                        <Star className="h-3.5 w-3.5" fill={i === 0 ? 'currentColor' : 'none'} strokeWidth={2.25} />
                        <span className="min-w-0 flex-1 break-words text-body">{nameOf(m)}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        aria-label={`Remove ${nameOf(m)} from this zone`}
                        className="shrink-0 text-fg-subtle hover:text-danger-ink"
                        onSelect={() => onRemoveCamera(m)}
                        title="Remove this camera from the zone"
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                      </DropdownMenuItem>
                    </div>
                  ))}
                  {addable.length ? <DropdownMenuSeparator /> : null}
                </>
              ) : null}
              {addable.length ? (
                <>
                  <DropdownMenuLabel className="text-body">
                    Span another camera
                    <span className="mt-0.5 block text-small font-normal leading-relaxed text-fg-subtle">
                      For a space too large for one view.
                    </span>
                  </DropdownMenuLabel>
                  {addable.map((c) => (
                    <DropdownMenuItem key={c.id} onSelect={() => onAddCamera(c.id)}>
                      <Plus className="h-3.5 w-3.5" strokeWidth={2.25} />
                      <span className="min-w-0 flex-1 break-words text-body">{c.label}</span>
                      {status(c) ? <span className="shrink-0 text-small text-fg-subtle">{status(c)}</span> : null}
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
