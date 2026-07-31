/**
 * Login Page — Premium glassmorphism dark-mode login.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../contexts/AuthContext';
import { useScrollLock } from '../hooks/useScrollLock';
import Logo from '../components/Logo';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  // Full-screen login card — freeze background scroll (iOS-safe) via the
  // shared hook instead of a hand-rolled overflow lock.
  useScrollLock();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    setLoading(true);

    try {
      // Trim the username only — passwords may legitimately contain leading or
      // trailing spaces, and trimming them here would make such a password
      // impossible to log in with.
      const result = await login(email.trim(), password);
      if (result && result.client_redirect) {
        // ProviderLogin resolves its own branding from the slug in the URL, so
        // there is no navigation state to thread through here.
        navigate(`/${result.slug}/login`);
      } else {
        // Nuke the PWA service-worker cache so the browser loads the
        // latest JS bundle instead of serving a stale cached version.
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        window.location.href = '/dashboard';
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">

      {/* ── Login Card ── */}
      <div className="login-card">
        <div className="login-logo">
          <Logo size={80} layout="vertical" />
        </div>

        {error && <div className="login-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <label className="input-label" htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              type="text"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="username"
            />
          </div>

          <div className="input-group">
            <label className="input-label" htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            style={{ width: '100%', marginTop: 8 }}
            disabled={loading}
          >
            {loading ? (
              <>
                <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
                Authenticating...
              </>
            ) : (
              'Sign In'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
