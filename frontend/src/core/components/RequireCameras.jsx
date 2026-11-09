import { Link } from 'react-router-dom';
import { ArrowRight, Wrench } from 'lucide-react';
import { Button } from '@/core/ui/button';
import { ErrorState, LoadingState } from '@/core/ui/states';
import { CAMERA_SETUP_PATH, CameraIllustration } from '@/core/components/CameraEmptyState';
import { useCameraPresence } from '@/core/hooks/useCameraPresence';
import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';

/**
 * Gate for pages that have nothing to show until the account has a camera.
 *
 *   <PageContent>
 *     <RequireCameras description="Add cameras … to watch them live.">
 *       …the page…
 *     </RequireCameras>
 *   </PageContent>
 *
 * Put it INSIDE PageContent so the page header stays: the operator still sees
 * which page they are on. Account-level only. "Nothing at this site" or
 * "nothing matches the filter" stays an inline EmptyState in the page, because
 * sending someone to Camera Setup for a filter would be wrong.
 *
 * The four states never blur together (see useCameraPresence). In particular,
 * a failed request is an error with retry, never "No cameras configured",
 * which would send an operator off to re-add cameras that are actually there.
 */
export function RequireCameras({
  children,
  enabled = true,
  title,
  description,
  benefits,
  canSetup = true,
  secondaryAction,
}) {
  const presence = useCameraPresence({ enabled });
  // A managed account (Add & edit cameras switched off) is never sent to a
  // setup page it cannot open.
  const user = useAuthStore((s) => s.user);
  const setupOn = makeEntitlement(user).has('camera_setup');

  if (presence.status === 'ready') return children;

  if (presence.status === 'loading') {
    return (
      <Frame>
        <LoadingState message="Loading cameras…" className="flex-1" />
      </Frame>
    );
  }

  if (presence.status === 'error') {
    return (
      <Frame>
        <ErrorState
          className="flex-1"
          title="Couldn't load cameras"
          description={presence.error?.message || 'Check your connection and try again.'}
          onRetry={presence.retry}
        />
      </Frame>
    );
  }

  return (
    <NoCamerasOnboarding
      title={title}
      description={description}
      benefits={benefits}
      canSetup={canSetup && setupOn}
      secondaryAction={secondaryAction}
    />
  );
}

function Frame({ children }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-surface shadow-sm">
      {children}
    </section>
  );
}

/**
 * The account has no cameras yet. Every camera-driven page shows this same
 * screen, and it has one action: go to Camera Setup. Pages don't offer a second
 * way to add a camera.
 *
 * `canSetup` is false for people who can't configure cameras (a guard at a
 * desk). They get told who can, not a button into a page they can't use.
 * `benefits` is optional: up to three { icon, title, text } saying what this
 * page does once cameras exist. `secondaryAction` is an optional button next
 * to Camera Setup, such as AI Feed's sample-data preview.
 */
export function NoCamerasOnboarding({
  title = 'No cameras configured',
  description = 'Add your cameras to get started.',
  benefits,
  canSetup = true,
  secondaryAction,
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
        <CameraIllustration />

        <h2 className="mt-6 text-title text-fg">{title}</h2>
        <p className="mt-2 max-w-[52ch] text-body leading-relaxed text-fg-muted">
          {canSetup ? description : 'Your admin has not added cameras to this account yet.'}
        </p>

        {canSetup || secondaryAction ? (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {canSetup ? (
              <Button asChild size="lg">
                <Link to={CAMERA_SETUP_PATH}>
                  <Wrench />
                  Add cameras
                  <ArrowRight />
                </Link>
              </Button>
            ) : null}
            {secondaryAction}
          </div>
        ) : null}
      </div>

      {benefits?.length ? (
        <div className="mx-6 shrink-0 border-t border-line py-6">
          <p className="text-heading text-fg">Once cameras are added</p>
          <ul className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-3 md:gap-0 md:divide-x md:divide-line">
            {benefits.map(({ icon: Icon, title: benefitTitle, text }) => (
              <li key={benefitTitle} className="flex items-start gap-3 md:px-6 md:first:pl-0 md:last:pr-0">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-soft text-brand">
                  <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
                </span>
                <div className="min-w-0">
                  <p className="text-body font-semibold text-fg">{benefitTitle}</p>
                  <p className="mt-0.5 text-small leading-relaxed text-fg-muted">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
