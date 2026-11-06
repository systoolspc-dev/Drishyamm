import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Input } from '@/core/ui/input';
import { Button } from '@/core/ui/button';
import { Eye, EyeOff, Mail, Lock, AlertCircle } from 'lucide-react';
import logo from '@/assets/drishyam-logo.svg';
import { useAuthStore } from '@/core/store/authStore';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const login = useAuthStore((state) => state.login);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(email, password);
      navigate('/home');
    } catch (err) {
      setError(err.response?.data?.message || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[var(--app-vh)] grid lg:grid-cols-2">
      {/* Left Side - Form */}
      <div className="flex items-center justify-center p-8 bg-surface">
        <div className="w-full max-w-md">
          {/* Logo */}
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-6">
              <img src={logo} alt="Drishyam" className="h-10 w-auto object-contain" />
              <span className="text-2xl font-bold text-fg">Drishyam</span>
            </div>
          </div>

          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-fg mb-2">
              Sign in to Drishyam
            </h1>
            <p className="text-fg-secondary">
              Drishyam helps you monitor, manage, and document your construction site — anytime, anywhere.
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="flex items-start gap-3 p-4 text-body text-danger-ink bg-danger-soft rounded-lg border border-danger-line">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
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
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-body font-medium text-fg mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-fg-subtle" />
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="pl-11 pr-11 h-12"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {/* Forgot Password */}
            <div className="text-right">
              <Link to="/forgot-password" className="text-body text-brand hover:text-brand-ink font-medium">
                Forgot password?
              </Link>
            </div>

            {/* Submit Button */}
            <Button
              type="submit"
              className="w-full h-12 bg-brand hover:bg-brand-hover text-white font-semibold text-heading"
              disabled={loading}
            >
              {loading ? 'Logging in...' : 'Log in'}
            </Button>

            {/* Sign Up Link */}
            <p className="text-center text-fg-secondary">
              Don't have an account?{' '}
              <Link to="/register" className="text-brand hover:text-brand-ink font-medium">
                Create a free account
              </Link>
            </p>
          </form>

          {/* Terms */}
          <p className="mt-8 text-small text-fg-muted text-center">
            By logging in, you agree to our{' '}
            <a href="#" className="text-brand hover:underline">Terms of Service</a>
            {' '}and{' '}
            <a href="#" className="text-brand hover:underline">Privacy Policy</a>.
          </p>
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
