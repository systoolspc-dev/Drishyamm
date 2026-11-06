import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, VideoOff, Video, AlertTriangle, Trash2, CheckCheck, Info, OctagonAlert } from 'lucide-react';
import { useNotificationStore } from '@/core/store/notificationStore';

const KIND = {
  'camera-offline': { icon: VideoOff, cls: 'text-danger bg-danger/10' },
  'camera-online':  { icon: Video, cls: 'text-success bg-success/10' },
  ai:               { icon: AlertTriangle, cls: 'text-warning bg-warning/10' },
  system:           { icon: Info, cls: 'text-fg-muted bg-surface-muted' },
  'system-error':   { icon: OctagonAlert, cls: 'text-danger bg-danger/10' },
};

function rel(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString([], { day: '2-digit', month: 'short' });
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const notifications = useNotificationStore((s) => s.notifications);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const clear = useNotificationStore((s) => s.clear);
  const navigate = useNavigate();
  const unread = notifications.filter((n) => !n.read).length;

  const toggle = () => {
    const opening = !open;
    setOpen(opening);
    if (opening && unread) markAllRead();
  };

  return (
    <div className="relative">
      <button
        onClick={toggle}
        title="Notifications"
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-muted hover:text-fg"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-danger px-1 text-micro font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 w-[340px] max-w-[calc(var(--app-vw)*0.9)] overflow-hidden rounded-xl border border-line bg-popover shadow-2xl">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <span className="text-body font-bold text-fg">Notifications</span>
              {notifications.length > 0 && (
                <div className="ml-auto flex items-center gap-1">
                  <button onClick={markAllRead} title="Mark all read" className="rounded p-1 text-fg-muted hover:bg-surface-muted hover:text-fg">
                    <CheckCheck className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={clear} title="Clear all" className="rounded p-1 text-fg-muted hover:bg-surface-muted hover:text-danger">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>

            <div className="max-h-[380px] overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="px-4 py-10 text-center text-small text-fg-muted">
                  <Bell className="mx-auto mb-2 h-5 w-5 opacity-40" />
                  You&rsquo;re all caught up
                </div>
              ) : (
                notifications.map((n) => {
                  const k = KIND[n.kind] || KIND.ai;
                  const Icon = k.icon;
                  return (
                    <button
                      key={n.id}
                      onClick={() => { setOpen(false); if (n.to) navigate(n.to); }}
                      className={`flex w-full items-start gap-3 border-b border-line/60 px-4 py-2.5 text-left transition hover:bg-surface-muted/50 ${!n.read ? 'bg-primary/[0.04]' : ''}`}
                    >
                      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${k.cls}`}>
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-small font-semibold text-fg">{n.title}</span>
                          {!n.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />}
                        </div>
                        {n.detail && <div className="truncate text-caption text-fg-muted">{n.detail}</div>}
                      </div>
                      <span className="shrink-0 text-micro tabular-nums text-fg-muted">{rel(n.ts)}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
