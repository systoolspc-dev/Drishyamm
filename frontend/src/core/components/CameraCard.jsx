import { Card, CardContent } from '@/core/ui/card';
import { Badge } from '@/core/ui/badge';
import { Video, VideoOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function CameraCard({ camera }) {
  const navigate = useNavigate();
  const isOnline = camera.mode === 'start';

  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={() => navigate(`/live?monitor=${encodeURIComponent(camera.mid)}`)}
    >
      <CardContent className="p-0">
        {/* Thumbnail */}
        <div className="relative aspect-video bg-surface-muted rounded-t-lg overflow-hidden">
          {camera.snapshot ? (
            <img
              src={camera.snapshot}
              alt={camera.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-fg-muted">
              {isOnline ? (
                <Video className="w-12 h-12" />
              ) : (
                <VideoOff className="w-12 h-12" />
              )}
            </div>
          )}

          {/* Status Badge */}
          <Badge
            variant={isOnline ? 'default' : 'destructive'}
            className="absolute top-2 right-2 text-small"
          >
            {isOnline ? 'Online' : 'Offline'}
          </Badge>
        </div>

        {/* Info */}
        <div className="p-3">
          <h3 className="font-semibold text-body truncate">{camera.name}</h3>
          <p className="text-small text-fg-muted mt-1">
            {camera.width && camera.height
              ? `${camera.width}x${camera.height}`
              : 'N/A'}{' '}
            &middot; {camera.fps || 30} FPS
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
