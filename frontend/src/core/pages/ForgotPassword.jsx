import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Input } from '@/core/ui/input';
import { Button } from '@/core/ui/button';
import { Mail, ArrowLeft, CheckCircle2, AlertCircle } from 'lucide-react';
import { useAuthStore } from '@/core/store/authStore';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | success | error
  const [message, setMessage] = useState('');
  const forgotPassword = useAuthStore((s) => s.forgotPassword);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus('loading');
    setMessage('');

    try {
      await forgotPassword(email.trim().toLowerCase());
      setStatus('success');
      setMessage(
        'Check your inbox! If an account with that email exists, we\'ve sent a password reset link. It expires in 1 hour.'
      );
    } catch (err) {
      // Even on network error show generic success to prevent enumeration
      const serverMsg = err.response?.data?.message;
      if (err.response?.status >= 500) {
        setStatus('error');
        setMessage('Something went wrong on our end. Please try again in a moment.');
      } else {
        setStatus('success');
        setMessage(
          serverMsg ||
          'Check your inbox! If an account with that email exists, we\'ve sent a password reset link.'
        );
      }
    }
  };

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

          {/* Back link */}
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 text-body text-fg-muted hover:text-fg-secondary mb-8"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to login
          </Link>

          <div className="mb-8">
            <h1 className="text-3xl font-bold text-fg mb-2">Forgot your password?</h1>
            <p className="text-fg-secondary">
              Enter your email address and we'll send you a link to reset your password.
            </p>
          </div>

          {/* Success State */}
          {status === 'success' ? (
            <div className="text-center py-4">
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 bg-success-soft rounded-full flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-success" />
                </div>
              </div>
              <h2 className="text-xl font-semibold text-fg mb-3">Email sent!</h2>
              <p className="text-fg-secondary text-body leading-relaxed mb-6">{message}</p>
              <p className="text-fg-muted text-body mb-6">
                Didn't receive it?{' '}
                <button
                  onClick={() => { setStatus('idle'); setMessage(''); }}
                  className="text-brand hover:text-brand-ink font-medium underline"
                >
                  Try again
                </button>
                {' '}or check your spam folder.
              </p>
              <Link to="/login">
                <Button className="w-full h-12 bg-brand hover:bg-brand-hover text-white font-semibold">
                  Return to login
                </Button>
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Error banner */}
              {status === 'error' && (
                <div className="flex items-start gap-3 p-4 text-body text-danger-ink bg-danger-soft rounded-lg border border-danger-line">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{message}</span>
                </div>
              )}

              {/* Email */}
              <div>
                <label className="block text-body font-medium text-fg mb-2">
                  Email address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-fg-subtle" />
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter your email"
                    className="pl-11 h-12"
                    required
                    autoFocus
                  />
                </div>
              </div>

              <Button
                type="submit"
                className="w-full h-12 bg-brand hover:bg-brand-hover text-white font-semibold text-heading"
                disabled={status === 'loading'}
              >
                {status === 'loading' ? 'Sending reset link...' : 'Send reset link'}
              </Button>

              <p className="text-center text-body text-fg-muted">
                Remember your password?{' '}
                <Link to="/login" className="text-brand hover:text-brand-ink font-medium">
                  Sign in
                </Link>
              </p>
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
        <div className="absolute bottom-12 left-12 right-12">
          <p className="text-white text-xl font-semibold leading-snug">
            "Drishyam helps you monitor, manage, and document your construction site — anytime, anywhere."
          </p>
        </div>
      </div>
    </div>
  );
}
