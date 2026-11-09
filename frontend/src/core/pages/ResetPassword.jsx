import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Input } from '@/core/ui/input';
import { Button } from '@/core/ui/button';
import { Lock, Eye, EyeOff, CheckCircle2, AlertCircle, ArrowLeft } from 'lucide-react';
import { useAuthStore } from '@/core/store/authStore';

function PasswordStrength({ password }) {
  if (!password) return null;

  const checks = [
    { label: 'At least 8 characters', ok: password.length >= 8 },
    { label: 'Uppercase letter (A-Z)', ok: /[A-Z]/.test(password) },
    { label: 'Lowercase letter (a-z)', ok: /[a-z]/.test(password) },
    { label: 'Number (0-9)', ok: /\d/.test(password) },
  ];

  const passed = checks.filter((c) => c.ok).length;
  const strengthLabel = ['', 'Weak', 'Fair', 'Good', 'Strong'][passed];
  const strengthColor = ['', 'bg-danger', 'bg-warning', 'bg-info', 'bg-success'][passed];

  return (
    <div className="mt-3 space-y-2">
      {/* Strength bar */}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-line rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${strengthColor}`}
            style={{ width: `${(passed / 4) * 100}%` }}
          />
        </div>
        <span className="text-small font-medium text-fg-muted w-12">{strengthLabel}</span>
      </div>
      {/* Checklist */}
      <ul className="space-y-1">
        {checks.map((c) => (
          <li key={c.label} className={`flex items-center gap-2 text-small ${c.ok ? 'text-success-ink' : 'text-fg-subtle'}`}>
            <span className={`w-3 h-3 rounded-full flex items-center justify-center text-micro ${c.ok ? 'bg-success-soft' : 'bg-surface-muted'}`}>
              {c.ok ? '✓' : ''}
            </span>
            {c.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const resetPassword = useAuthStore((s) => s.resetPassword);

  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [status, setStatus] = useState('idle'); // idle | loading | success | error
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setErrorMsg('This reset link is invalid. Please request a new one.');
    }
  }, [token]);

  const isValid = password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password);
  const matches = password === confirm;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMsg('');

    if (!isValid) {
      setErrorMsg('Please choose a stronger password that meets all requirements.');
      return;
    }
    if (!matches) {
      setErrorMsg('Passwords do not match. Please check and try again.');
      return;
    }

    setStatus('loading');
    try {
      await resetPassword(token, password);
      setStatus('success');
    } catch (err) {
      setStatus('error');
      const msg = err.response?.data?.message;
      setErrorMsg(
        msg || 'This reset link has expired or is no longer valid. Please request a new one.'
      );
    }
  };

  if (status === 'success') {
    return (
      <div className="min-h-[var(--app-vh)] flex items-center justify-center bg-surface-sunken p-8">
        <div className="w-full max-w-md text-center">
          <div className="flex justify-center mb-6">
            <div className="w-20 h-20 bg-success-soft rounded-full flex items-center justify-center">
              <CheckCircle2 className="w-10 h-10 text-success" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-fg mb-3">Password reset!</h1>
          <p className="text-fg-secondary mb-8">
            Your password has been changed successfully. You can now sign in with your new password.
            All other sessions have been logged out for your security.
          </p>
          <Button
            onClick={() => navigate('/login')}
            className="w-full h-12 bg-brand hover:bg-brand-hover text-white font-semibold"
          >
            Sign in to Drishyam
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[var(--app-vh)] grid lg:grid-cols-2">
      {/* Left Side - Form */}
      <div className="flex items-center justify-center p-8 bg-surface">
        <div className="w-full max-w-md">
          {/* Logo */}
          <div className="flex items-center gap-3 mb-8">
            <div className="w-12 h-12 bg-gradient-to-br from-brand to-brand rounded-xl flex items-center justify-center">
              <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <span className="text-2xl font-bold text-fg">Drishyam</span>
          </div>

          <Link to="/login" className="inline-flex items-center gap-1.5 text-body text-fg-muted hover:text-fg-secondary mb-8">
            <ArrowLeft className="w-4 h-4" />
            Back to login
          </Link>

          <div className="mb-8">
            <h1 className="text-3xl font-bold text-fg mb-2">Create new password</h1>
            <p className="text-fg-secondary">Choose a strong password to keep your account secure.</p>
          </div>

          {/* Invalid token state */}
          {!token && status === 'error' ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 text-body text-danger-ink bg-danger-soft rounded-lg border border-danger-line">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{errorMsg}</span>
              </div>
              <Link to="/forgot-password">
                <Button className="w-full h-12 bg-brand hover:bg-brand-hover text-white font-semibold">
                  Request a new reset link
                </Button>
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Error banner */}
              {errorMsg && (
                <div className="flex items-start gap-3 p-4 text-body text-danger-ink bg-danger-soft rounded-lg border border-danger-line">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <span>{errorMsg}</span>
                    {status === 'error' && (
                      <span className="block mt-1">
                        <Link to="/forgot-password" className="text-brand hover:text-brand-ink font-medium underline">
                          Request a new link →
                        </Link>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* New Password */}
              <div>
                <label className="block text-body font-medium text-fg mb-2">New password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-fg-subtle" />
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Create a strong password"
                    className="pl-11 pr-11 h-12"
                    required
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
                <PasswordStrength password={password} />
              </div>

              {/* Confirm Password */}
              <div>
                <label className="block text-body font-medium text-fg mb-2">Confirm password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-fg-subtle" />
                  <Input
                    type={showConfirm ? 'text' : 'password'}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Repeat your new password"
                    className={`pl-11 pr-11 h-12 ${confirm && !matches ? 'border-danger focus-visible:ring-danger-line' : ''}`}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm(!showConfirm)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
                  >
                    {showConfirm ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
                {confirm && !matches && (
                  <p className="mt-1.5 text-small text-danger">Passwords don't match</p>
                )}
                {confirm && matches && password && (
                  <p className="mt-1.5 text-small text-success-ink flex items-center gap-1">
                    <span className="w-3 h-3 rounded-full bg-success-soft flex items-center justify-center text-micro">✓</span>
                    Passwords match
                  </p>
                )}
              </div>

              <Button
                type="submit"
                className="w-full h-12 bg-brand hover:bg-brand-hover text-white font-semibold text-heading"
                disabled={status === 'loading' || !isValid || !matches}
              >
                {status === 'loading' ? 'Resetting password...' : 'Reset password'}
              </Button>
            </form>
          )}
        </div>
      </div>

      {/* Right Side - Image */}
      <div className="hidden lg:block relative bg-neutral-900">
        <img
          src="https://images.unsplash.com/photo-1541888946425-d81bb19240f5?w=1920&q=80"
          alt="Construction site"
          className="w-full h-full object-cover opacity-90"
        />
        <div className="absolute inset-0 bg-gradient-to-br from-brand/20 to-transparent" />
      </div>
    </div>
  );
}
