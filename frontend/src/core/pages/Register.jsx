import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Input } from '@/core/ui/input';
import { Button } from '@/core/ui/button';
import { Eye, EyeOff, Mail, Lock, User, AlertCircle, CheckCircle2 } from 'lucide-react';
import logo from '@/assets/drishyam-logo.svg';
import { useAuthStore } from '@/core/store/authStore';


function PasswordStrength({ password }) {
  if (!password) return null;
  const checks = [
    { label: 'At least 8 characters', ok: password.length >= 8 },
    { label: 'Uppercase letter', ok: /[A-Z]/.test(password) },
    { label: 'Lowercase letter', ok: /[a-z]/.test(password) },
    { label: 'Number', ok: /\d/.test(password) },
  ];
  const passed = checks.filter((c) => c.ok).length;
  const bars = ['', 'bg-danger', 'bg-warning', 'bg-info', 'bg-success'];
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  return (
    <div className="mt-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-200 ${i <= passed ? bars[passed] : 'bg-line'}`} />
        ))}
        <span className="text-small text-fg-muted w-10 text-right">{labels[passed]}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5">
        {checks.map((c) => (
          <span key={c.label} className={`text-small flex items-center gap-1 ${c.ok ? 'text-success-ink' : 'text-fg-subtle'}`}>
            {c.ok ? '✓' : '○'} {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

const FEATURES = [
  { icon: '📹', text: 'Connect unlimited cameras on premium plans' },
  { icon: '☁️', text: 'Cloud recording with S3 storage' },
  { icon: '🗺️', text: 'Live map view and site monitoring' },
  { icon: '⏱️', text: 'Timelapse generation and playback' },
  { icon: '🔔', text: 'Real-time alerts and notifications' },
  { icon: '🔒', text: 'Enterprise-grade security' },
];

export default function Register() {
  const navigate = useNavigate();
  const register = useAuthStore((s) => s.register);

  const [form, setForm] = useState({ name: '', email: '', password: '', tier: 'ai_vms' });
  const [showPassword, setShowPassword] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const set = (field) => (e) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
    setFieldErrors((fe) => ({ ...fe, [field]: '' }));
    setError('');
  };

  const isPasswordValid =
    form.password.length >= 8 &&
    /[A-Z]/.test(form.password) &&
    /[a-z]/.test(form.password) &&
    /\d/.test(form.password);

  const validate = () => {
    const errs = {};
    if (!form.name.trim() || form.name.trim().length < 2) errs.name = 'Full name must be at least 2 characters.';
    if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = 'Enter a valid email address.';
    if (!isPasswordValid) errs.password = 'Password must be at least 8 characters with uppercase, lowercase, and a number.';
    if (!agreed) errs.terms = 'You must agree to the Terms of Service to continue.';
    return errs;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }

    setLoading(true);
    try {
      await register({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        password: form.password,
        tier: form.tier,
      });

      // authStore.register() handles all token storage and state update
      setSuccess(true);
      setTimeout(() => navigate('/home'), 1500);
    } catch (err) {
      const msg = err.response?.data?.message;
      const status = err.response?.status;
      if (status === 409) {
        setFieldErrors({ email: 'An account with this email already exists.' });
      } else if (status === 422 || status === 400) {
        setError(msg || 'Please check your details and try again.');
      } else {
        setError(msg || 'Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-[var(--app-vh)] flex items-center justify-center bg-surface">
        <div className="text-center">
          <div className="flex justify-center mb-4">
            <div className="w-16 h-16 bg-success-soft rounded-full flex items-center justify-center">
              <CheckCircle2 className="w-8 h-8 text-success" />
            </div>
          </div>
          <h2 className="text-xl font-bold text-fg mb-2">Account created!</h2>
          <p className="text-fg-muted text-body">Taking you to your dashboard…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[var(--app-vh)] grid lg:grid-cols-2">
      {/* Left — Form */}
      <div className="flex items-center justify-center p-8 bg-surface overflow-y-auto">
        <div className="w-full max-w-md py-4">
          {/* Logo */}
          <div className="flex items-center gap-3 mb-8">
            <img src={logo} alt="Drishyam" className="h-10 w-auto object-contain shrink-0" />
            <div>
              <span className="text-2xl font-bold text-fg">Drishyam</span>
              <span className="ml-2 text-small font-medium bg-brand-soft text-brand-ink px-2 py-0.5 rounded-full">Free plan included</span>
            </div>
          </div>

          <div className="mb-7">
            <h1 className="text-3xl font-bold text-fg mb-2">Create your account</h1>
            <p className="text-fg-secondary">Start monitoring your sites in minutes. No credit card required.</p>
          </div>

          {/* Global error */}
          {error && (
            <div className="flex items-start gap-3 p-4 mb-5 text-body text-danger-ink bg-danger-soft rounded-lg border border-danger-line">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            {/* Plan tier */}
            <div>
              <label className="block text-body font-medium text-fg mb-1.5">Choose your plan</label>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { id: 'basic_vms', name: 'Basic VMS', desc: 'Live view, recording & playback' },
                  { id: 'ai_vms', name: 'AI + VMS', desc: 'Adds face, ANPR, weapon & crowd AI' },
                ].map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => setForm((f) => ({ ...f, tier: t.id }))}
                    className={`text-left rounded-lg border p-3 transition ${
                      form.tier === t.id
                        ? 'border-brand ring-2 ring-brand-line bg-brand-soft/50'
                        : 'border-line hover:border-line-strong'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-body text-fg">{t.name}</span>
                      {form.tier === t.id && <CheckCircle2 className="w-4 h-4 text-brand" />}
                    </div>
                    <p className="text-small text-fg-muted mt-0.5">{t.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Full Name */}
            <div>
              <label className="block text-body font-medium text-fg mb-1.5">Full name</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-fg-subtle" />
                <Input
                  type="text"
                  value={form.name}
                  onChange={set('name')}
                  placeholder="Your full name"
                  className={`pl-11 h-12 ${fieldErrors.name ? 'border-danger focus-visible:ring-danger-line' : ''}`}
                  autoComplete="name"
                  autoFocus
                />
              </div>
              {fieldErrors.name && <p className="mt-1.5 text-small text-danger">{fieldErrors.name}</p>}
            </div>

            {/* Email */}
            <div>
              <label className="block text-body font-medium text-fg mb-1.5">Work email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-fg-subtle" />
                <Input
                  type="email"
                  value={form.email}
                  onChange={set('email')}
                  placeholder="you@company.com"
                  className={`pl-11 h-12 ${fieldErrors.email ? 'border-danger focus-visible:ring-danger-line' : ''}`}
                  autoComplete="email"
                />
              </div>
              {fieldErrors.email && <p className="mt-1.5 text-small text-danger">{fieldErrors.email}</p>}
            </div>

            {/* Password */}
            <div>
              <label className="block text-body font-medium text-fg mb-1.5">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-fg-subtle" />
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={set('password')}
                  placeholder="Create a strong password"
                  className={`pl-11 pr-11 h-12 ${fieldErrors.password ? 'border-danger focus-visible:ring-danger-line' : ''}`}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
              {fieldErrors.password && <p className="mt-1.5 text-small text-danger">{fieldErrors.password}</p>}
              <PasswordStrength password={form.password} />
            </div>

            {/* Terms */}
            <div>
              <div className="flex items-start gap-3">
                {/* Real checkbox — visible, properly associated via id/htmlFor */}
                <input
                  id="agree-terms"
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => {
                    setAgreed(e.target.checked);
                    setFieldErrors((fe) => ({ ...fe, terms: '' }));
                  }}
                  className={`mt-1 w-4 h-4 rounded accent-brand cursor-pointer shrink-0
                    ${fieldErrors.terms ? 'ring-2 ring-danger ring-offset-1' : ''}`}
                />
                <label htmlFor="agree-terms" className="text-body text-fg-secondary leading-snug cursor-pointer select-none">
                  I agree to the{' '}
                  <a
                    href="#"
                    className="text-brand hover:underline font-medium"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  >
                    Terms of Service
                  </a>
                  {' '}and{' '}
                  <a
                    href="#"
                    className="text-brand hover:underline font-medium"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  >
                    Privacy Policy
                  </a>
                </label>
              </div>
              {fieldErrors.terms && (
                <p className="mt-1.5 text-small text-danger flex items-center gap-1">
                  <AlertCircle className="w-3 h-3 shrink-0" />
                  {fieldErrors.terms}
                </p>
              )}
            </div>

            {/* Submit */}
            <Button
              type="submit"
              className="w-full h-12 bg-brand hover:bg-brand-hover text-white font-semibold text-heading"
              disabled={loading}
            >
              {loading ? 'Creating account…' : 'Create free account'}
            </Button>

            <p className="text-center text-fg-secondary text-body">
              Already have an account?{' '}
              <Link to="/login" className="text-brand hover:text-brand-ink font-medium">
                Sign in
              </Link>
            </p>
          </form>
        </div>
      </div>

      {/* Right — Feature highlights */}
      <div className="hidden lg:flex flex-col relative bg-neutral-900 overflow-hidden">
        <img
          src="https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=1920&q=80"
          alt="Construction site monitoring"
          className="absolute inset-0 w-full h-full object-cover opacity-40"
        />
        <div className="absolute inset-0 bg-gradient-to-br from-brand/40 to-neutral-900/80" />

        <div className="relative z-10 flex flex-col justify-center h-full p-12">
          <div className="mb-10">
            <h2 className="text-3xl font-bold text-white mb-3 leading-snug">
              Everything you need to monitor your sites
            </h2>
            <p className="text-white/85 text-heading">
              Smart-Cam gives construction teams complete visibility — from anywhere in the world.
            </p>
          </div>

          <ul className="space-y-4">
            {FEATURES.map(({ icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <span className="text-xl">{icon}</span>
                <span className="text-white/85 text-body">{text}</span>
              </li>
            ))}
          </ul>

          <div className="mt-10 pt-8 border-t border-white/20">
            <p className="text-white/60 text-small">
              Free plan includes 2 cameras · No credit card needed · Cancel anytime
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
