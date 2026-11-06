import { useState, useEffect, useRef } from 'react';
import { Mail, ExternalLink, ChevronRight } from 'lucide-react';

// ─── Prose primitives ─────────────────────────────────────────────────────────

function H2({ id, children }) {
  return (
    <h2 id={id} className="text-section text-fg mt-12 mb-4 leading-snug scroll-mt-20 first:mt-0">
      {children}
    </h2>
  );
}

function H3({ id, children }) {
  return (
    <h3 id={id} className="text-heading font-semibold text-fg mt-8 mb-3 scroll-mt-20">
      {children}
    </h3>
  );
}

function P({ children }) {
  return <p className="text-body text-fg-muted leading-relaxed mb-4">{children}</p>;
}

function B({ children }) {
  return <strong className="font-semibold text-fg">{children}</strong>;
}

function Code({ children }) {
  return (
    <code className="bg-surface-muted text-fg text-small font-mono px-1.5 py-0.5 rounded border border-line">
      {children}
    </code>
  );
}

function Divider() {
  return <hr className="border-line my-10" />;
}

function Note({ children, type = 'info' }) {
  const styles = {
    // No dark: overrides needed — the soft/line/ink tokens already redefine
    // themselves as translucent variants under .dark in index.css.
    info:    'bg-info-soft border-info-line text-info-ink',
    warning: 'bg-warning-soft border-warning-line text-warning-ink',
    tip:     'bg-success-soft border-success-line text-success-ink',
  };
  const label = { info: 'Note', warning: 'Warning', tip: 'Tip' };
  return (
    <div className={`border rounded-lg px-4 py-3 mb-4 text-body leading-relaxed ${styles[type]}`}>
      <span className="font-bold mr-1.5">{label[type]}:</span>
      {children}
    </div>
  );
}

function StepList({ steps }) {
  return (
    <ol className="space-y-3 mb-4">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-caption font-bold flex items-center justify-center shrink-0 mt-0.5">
            {i + 1}
          </span>
          <span className="text-body text-fg-muted leading-relaxed">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function BulletList({ items }) {
  return (
    <ul className="space-y-1.5 mb-4 ml-4">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-body text-fg-muted leading-relaxed">
          <span className="text-primary mt-1.5 text-micro">●</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Table({ head, rows }) {
  return (
    <div className="overflow-x-auto mb-6 rounded-lg border border-line">
      <table className="w-full text-body">
        <thead>
          <tr className="bg-surface-muted">
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5 text-left font-semibold text-fg border-b border-line">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, i) => (
            <tr key={i} className="bg-surface hover:bg-surface-muted/50 transition-colors">
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-2.5 text-fg-muted">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── FAQ accordion ────────────────────────────────────────────────────────────

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-line rounded-lg overflow-hidden mb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-4 px-4 py-3.5 text-left bg-surface hover:bg-surface-muted/50 transition-colors"
      >
        <span className="text-body font-medium text-fg">{q}</span>
        <ChevronRight className={`w-4 h-4 text-fg-muted shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="px-4 py-3.5 border-t border-line bg-surface-muted/20">
          <p className="text-body text-fg-muted leading-relaxed">{a}</p>
        </div>
      )}
    </div>
  );
}

// ─── Left nav ─────────────────────────────────────────────────────────────────

const NAV_SECTIONS = [
  {
    heading: 'Start here',
    items: [
      { id: 'introduction', label: 'Welcome' },
      { id: 'quick-start',  label: 'Getting started' },
    ],
  },
  {
    heading: 'Everyday use',
    items: [
      { id: 'live-view',   label: 'Watch live' },
      { id: 'video-wall',  label: 'Video wall' },
      { id: 'recordings',  label: 'Recordings' },
      { id: 'map',         label: 'Map' },
      { id: 'alerts',      label: 'Alerts' },
    ],
  },
  {
    heading: 'Setup',
    items: [
      { id: 'cameras',       label: 'Add cameras' },
      { id: 'camera-status', label: 'Camera status' },
      { id: 'team',          label: 'Your team' },
      { id: 'account',       label: 'Your account' },
    ],
  },
  {
    heading: 'Plans',
    items: [
      { id: 'plans', label: 'Basic VMS and AI + VMS' },
    ],
  },
  {
    heading: 'Help',
    items: [
      { id: 'faq',     label: 'Common questions' },
      { id: 'support', label: 'Contact us' },
    ],
  },
];

function DocNav({ active }) {
  return (
    <nav className="space-y-5">
      {NAV_SECTIONS.map(({ heading, items }) => (
        <div key={heading}>
          <p className="text-caption font-semibold uppercase tracking-widest text-fg-muted mb-2 px-2">
            {heading}
          </p>
          <ul className="space-y-0.5">
            {items.map(({ id, label }) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className={`block px-2 py-1.5 text-body rounded-md transition-colors ${
                    active === id
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-fg-muted hover:text-fg hover:bg-surface-muted/60'
                  }`}
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

// ─── Main docs content ────────────────────────────────────────────────────────

const SUPPORT_EMAIL = 'hello@drishyam.ai';
const SALES_EMAIL = 'sales@drishyam.ai';

function DocContent() {
  return (
    <article className="max-w-[720px]">

      {/* ── Welcome ── */}
      <H2 id="introduction">Welcome to Drishyam</H2>
      <P>
        Drishyam lets you watch, record and look back at your cameras from anywhere, in one place.
        Open it in your browser, see your cameras live, and find any moment from your recordings in a
        few clicks.
      </P>
      <P>
        Everything is in the menu on the left. You only see the parts that are switched on for your
        account, so your menu may be shorter than the one described here.
      </P>
      <Note type="tip">
        New here? Go to <a href="#quick-start" className="underline font-medium">Getting started</a> and
        you will see your first camera in a few minutes.
      </Note>

      <Divider />

      {/* ── Getting started ── */}
      <H2 id="quick-start">Getting started</H2>
      <StepList steps={[
        <>Open <B>Setup → Add cameras</B> and add your recorder (NVR/DVR) or a single camera. Keep its address, username and password handy.</>,
        <>Drishyam finds the cameras on your recorder. Give each one a name you will recognise, like "Main gate" or "Store front".</>,
        <>Open <B>Cameras → Watch live</B>. Your cameras appear within a few seconds.</>,
        <>To look back at something, open <B>Cameras → Recordings</B>, pick a camera, a date and a time.</>,
      ]} />
      <Note type="info">
        If a camera does not show a picture, open <B>Setup → Camera status</B>. It tells you in plain words
        whether the camera or the recorder is offline.
      </Note>

      <Divider />

      {/* ── Watch live ── */}
      <H2 id="live-view">Watch live</H2>
      <P>
        <B>Cameras → Watch live</B> shows your cameras as they are right now.
      </P>
      <BulletList items={[
        'Click a camera to see it large.',
        'Switch between one camera and a grid of cameras from the top of the page.',
        'If the internet drops for a moment, the picture comes back on its own. You do not need to refresh.',
        'On a slow connection, choose a lower picture quality for that camera so it plays smoothly.',
      ]} />

      <Divider />

      {/* ── Video wall ── */}
      <H2 id="video-wall">Video wall</H2>
      <P>
        <B>Cameras → Video wall</B> shows many cameras on one screen, which is useful on a big monitor in a
        security room or at a reception desk. Pick a wall, then open it full screen.
      </P>

      <Divider />

      {/* ── Recordings ── */}
      <H2 id="recordings">Recordings</H2>
      <P>
        <B>Cameras → Recordings</B> is where you go back in time. Depending on your account, it has up
        to three tabs:
      </P>
      <Table
        head={['Tab', 'What it shows']}
        rows={[
          ['Site recorder', 'Footage saved on your own recorder (NVR/DVR) at your site. Nothing needs to be uploaded first.'],
          ['Cloud', 'Clips saved by Drishyam in the cloud, so you can watch them even if your recorder is switched off.'],
          ['Timelapse', 'A whole day or week squeezed into a few minutes, handy for seeing how work progressed.'],
        ]}
      />
      <H3>Finding a moment</H3>
      <StepList steps={[
        'Pick the camera and the date.',
        'Click on the timeline to jump to that time.',
        'Use the speed buttons to fast-forward.',
        'To keep a piece of video, select the start and end and download it.',
      ]} />

      <Divider />

      {/* ── Map ── */}
      <H2 id="map">Map</H2>
      <P>
        <B>Cameras → Map</B> shows where your sites and cameras are. Click a site to see its cameras.
        This is most useful when you have cameras in more than one place.
      </P>

      <Divider />

      {/* ── Alerts ── */}
      <H2 id="alerts">Alerts</H2>
      <P>
        If your account includes alerts, <B>Alerts</B> lists the things that need your attention, such as a
        camera going offline. You can also get them by email or on your phone. Ask us to switch these on
        if you do not see them.
      </P>

      <Divider />

      {/* ── Add cameras ── */}
      <H2 id="cameras">Add cameras</H2>
      <StepList steps={[
        <>Open <B>Setup → Add cameras</B>.</>,
        'Choose whether you are adding a recorder (NVR/DVR) with many cameras, or a single camera.',
        "Enter the recorder's address, username and password. These are the same details you use to log in to the recorder itself.",
        <>Click <B>Save</B>. Your cameras appear in the list and in <B>Watch live</B>.</>,
      ]} />
      <Note type="warning">
        Your recorder must be reachable from the internet. If you are not sure, ask the person who installed
        your cameras, or contact us and we will help you set it up.
      </Note>
      <P>
        You can add up to the number of cameras in your plan. The page shows how many you have left.
      </P>

      <Divider />

      {/* ── Camera status ── */}
      <H2 id="camera-status">Camera status</H2>
      <P>
        <B>Setup → Camera status</B> shows every camera and whether it is working.
      </P>
      <Table
        head={['Status', 'What it means']}
        rows={[
          ['Online', 'The camera is working.'],
          ['Offline', 'Drishyam cannot reach the camera. Check its power and cable.'],
          ['Recorder offline', 'The whole recorder cannot be reached. Check the power and internet at that site.'],
        ]}
      />

      <Divider />

      {/* ── Your team ── */}
      <H2 id="team">Your team</H2>
      <P>
        Add the people who need to watch your cameras in <B>Setup → Users</B>. Each person gets their own
        login, and you choose what they are allowed to see and do. When someone leaves, remove them and
        their access stops straight away.
      </P>

      <Divider />

      {/* ── Your account ── */}
      <H2 id="account">Your account</H2>
      <H3>Changing your name or email</H3>
      <P>
        Go to <B>Setup → Settings</B>. Changes are saved straight away. If you change your email, use the
        new email the next time you log in.
      </P>
      <H3>Changing your password</H3>
      <P>
        Go to <B>Setup → Settings → Change password</B>. Use at least 8 characters, with a capital letter,
        a small letter and a number. You will be signed out on your other devices.
      </P>
      <H3>Forgot your password?</H3>
      <P>
        On the login page, click <B>Forgot password?</B> and enter your email. We send you a link that works
        once, for one hour. Check your spam folder if it does not arrive.
      </P>

      <Divider />

      {/* ── Plans ── */}
      <H2 id="plans">Basic VMS and AI + VMS</H2>
      <Table
        head={['Plan', 'What you get']}
        rows={[
          ['Basic VMS', 'Watch live, video wall, recordings, camera status and your team.'],
          ['AI + VMS', 'Everything in Basic VMS, plus smart features such as people counting, known-people alerts and no-entry area alerts.'],
        ]}
      />
      <Note type="info">
        The number of cameras and the smart features on your account are set by your plan. To add cameras
        or features, write to <B>{SALES_EMAIL}</B>.
      </Note>

      <Divider />

      {/* ── Common questions ── */}
      <H2 id="faq">Common questions</H2>

      {[
        {
          q: "My camera is not showing a picture. What do I do?",
          a: "Open Setup → Camera status. If it says the camera is offline, check that the camera has power and its cable is connected. If it says the recorder is offline, check the power and internet at that site. If everything looks fine and it still does not work, contact us and tell us which camera it is.",
        },
        {
          q: "The video is slow or keeps pausing.",
          a: "This usually means a slow internet connection at your site or on your device. Choose a lower picture quality for that camera, or watch fewer cameras at the same time.",
        },
        {
          q: "Can I use Drishyam on my phone?",
          a: "Yes. Open it in the browser on your phone (Chrome or Safari) and log in. You can add it to your home screen from the browser menu so it opens like an app.",
        },
        {
          q: "How long are my recordings kept?",
          a: "Footage on your own recorder is kept for as long as the recorder's hard disk has space. Cloud clips are kept for the number of days set for your account. Ask us if you need them kept longer.",
        },
        {
          q: "Who can see my cameras?",
          a: "Only you and the people you add in Setup → Users. Everything travels over a secure, encrypted connection.",
        },
        {
          q: "I am being logged out. Why?",
          a: "You stay logged in for up to 30 days on the same device. You are logged out if you change your password, if you log out yourself, or if your browser clears its data when it closes (private or incognito windows do this).",
        },
        {
          q: "Which browsers work?",
          a: "Recent versions of Chrome, Edge, Firefox and Safari, on computers and phones.",
        },
      ].map((item) => (
        <FaqItem key={item.q} {...item} />
      ))}

      <Divider />

      {/* ── Contact ── */}
      <H2 id="support">Contact us</H2>
      <P>
        We are here <B>Monday to Friday, 9 AM to 6 PM IST</B>. Tell us your account email, which camera or
        page the problem is on, and what you see. A screenshot helps.
      </P>

      <div className="mt-6 grid sm:grid-cols-2 gap-4">
        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          className="flex items-center gap-3 p-4 bg-surface border border-line rounded-xl hover:border-primary/40 hover:bg-primary/5 transition-all group"
        >
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Mail className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-body font-semibold text-fg group-hover:text-primary transition-colors">Help with your account</p>
            <p className="text-small text-fg-muted select-all">{SUPPORT_EMAIL}</p>
          </div>
          <ExternalLink className="w-3.5 h-3.5 text-fg-muted ml-auto opacity-60" />
        </a>

        <a
          href={`mailto:${SALES_EMAIL}`}
          className="flex items-center gap-3 p-4 bg-surface border border-line rounded-xl hover:border-primary/40 hover:bg-primary/5 transition-all group"
        >
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Mail className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-body font-semibold text-fg group-hover:text-primary transition-colors">More cameras or features</p>
            <p className="text-small text-fg-muted select-all">{SALES_EMAIL}</p>
          </div>
          <ExternalLink className="w-3.5 h-3.5 text-fg-muted ml-auto opacity-60" />
        </a>
      </div>

    </article>
  );
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function Help() {
  const [activeSection, setActiveSection] = useState('introduction');
  const contentRef = useRef(null);

  // Highlight the active section in the left nav based on scroll position
  useEffect(() => {
    const allIds = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.id));

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) {
          setActiveSection(visible[0].target.id);
        }
      },
      { rootMargin: '-20% 0px -60% 0px', threshold: 0 }
    );

    allIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex min-h-[calc(var(--app-vh)-4rem)]">

      {/* ── Left sidebar nav (hidden on mobile) ── */}
      <aside className="hidden xl:block w-[220px] shrink-0 border-r border-line">
        <div className="sticky top-0 h-[calc(var(--app-vh)-4rem)] overflow-y-auto py-8 px-4">
          <div className="mb-6 px-2">
            <p className="text-caption font-semibold uppercase tracking-widest text-primary mb-0.5">Drishyam</p>
            <p className="text-heading font-bold text-fg leading-tight">Help</p>
          </div>

          <DocNav active={activeSection} />
        </div>
      </aside>

      {/* ── Main content ── */}
      <div ref={contentRef} className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-[780px] mx-auto px-6 lg:px-10 py-10">

          <div className="mb-10">
            <p className="text-small font-semibold uppercase tracking-widest text-primary mb-2">Drishyam Help</p>
            <h1 className="text-title text-fg leading-tight mb-3">
              How to use Drishyam
            </h1>
            <p className="text-heading text-fg-muted leading-relaxed max-w-[560px]">
              Short, simple answers: adding cameras, watching live, finding recordings, and getting help.
            </p>

            <div className="flex flex-wrap gap-2 mt-5">
              {[
                { href: '#quick-start', label: 'Getting started' },
                { href: '#cameras',     label: 'Add cameras' },
                { href: '#recordings',  label: 'Recordings' },
                { href: '#faq',         label: 'Common questions' },
                { href: '#support',     label: 'Contact us' },
              ].map(({ href, label }) => (
                <a
                  key={href}
                  href={href}
                  className="inline-flex items-center text-small font-medium bg-surface-muted hover:bg-primary/10 hover:text-primary text-fg-muted px-3 py-1.5 rounded-full border border-line transition-colors"
                >
                  {label}
                </a>
              ))}
            </div>
          </div>

          <hr className="border-line mb-10" />

          <DocContent />

          <div className="mt-16 pt-8 border-t border-line text-center">
            <p className="text-small text-fg-muted">
              Drishyam Help ·{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary hover:underline">{SUPPORT_EMAIL}</a>
            </p>
          </div>
        </div>
      </div>

    </div>
  );
}
