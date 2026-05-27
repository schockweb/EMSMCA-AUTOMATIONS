/**
 * ProviderLogin — Unified login portal for a service provider.
 * Admin role → /:slug/admin/dashboard
 * Crew role  → /:slug/crew/dashboard
 */
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';

const G = '#10b981';
const GD = '#059669';
const T = '#0f172a';
const M = '#475569';
const B = '#e2e8f0';

export default function ProviderLogin() {
  const { providerSlug } = useParams<{ providerSlug: string }>();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [providerName, setProviderName] = useState('');

  useEffect(() => {
    axios.get('/api/providers/public')
      .then(res => {
        const p = res.data.find((p: any) => p.slug === providerSlug);
        if (p) setProviderName(p.name);
      }).catch(() => {});
  }, [providerSlug]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await axios.post('/api/crew/login', {
        email: email.trim().toLowerCase(),
        password: password.trim(),
      });
      const data = res.data;
      localStorage.setItem('crew_token', data.access_token);
      localStorage.setItem('crew_profile', JSON.stringify({
        id: data.crew_id,
        name: data.crew_name,
        provider_id: data.provider_id,
        provider_name: data.provider_name,
        provider_slug: data.provider_slug,
        qualification: data.qualification,
        hpcsa_number: data.hpcsa_number,
        role: data.role,
      }));
      if (data.role === 'admin') {
        navigate(`/${data.provider_slug}/admin/dashboard`);
      } else {
        navigate(`/${data.provider_slug}/crew/dashboard`);
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Login failed. Check your credentials.');
    }
    setLoading(false);
  };

  const field: React.CSSProperties = {
    width: '100%', padding: '13px 16px', fontSize: '0.94rem',
    borderRadius: 10, border: `1px solid ${B}`,
    background: '#f8fafc', color: T, fontWeight: 500,
    marginBottom: 18, outline: 'none', boxSizing: 'border-box', transition: 'all 0.2s',
    fontFamily: 'inherit',
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: '#f8fafc', padding: '24px 20px', position: 'relative',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      {/* Back */}
      <button onClick={() => navigate('/login')} style={{
        position: 'absolute', top: 20, left: 20,
        background: '#ffffff', border: `1px solid ${B}`,
        borderRadius: 8, padding: '7px 14px', color: M,
        fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
      }}>
        Back
      </button>

      {/* Logo / Name */}
      {providerSlug?.toLowerCase() === 'jems' ? (
        <img src="/jems_logo.png" alt="JEMS Medical Services" style={{ width: 240, height: 'auto', marginBottom: 28 }} />
      ) : (
        <>
          <div style={{
            width: 72, height: 72, borderRadius: 18,
            background: `linear-gradient(135deg, ${G}, ${GD})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 14, boxShadow: `0 8px 24px rgba(16,185,129,0.2)`,
            fontSize: '1.8rem', fontWeight: 800, color: '#fff',
          }}>
            {(providerName || providerSlug || '?')[0].toUpperCase()}
          </div>
          <h1 style={{ color: T, fontSize: '1.5rem', fontWeight: 800, margin: '0 0 4px', textAlign: 'center', letterSpacing: '-0.02em' }}>
            {providerName || providerSlug?.toUpperCase()}
          </h1>
        </>
      )}

      <p style={{ color: M, fontSize: '0.82rem', margin: '0 0 32px', textAlign: 'center', fontWeight: 500, letterSpacing: '0.02em' }}>
        Administration Portal
      </p>

      {/* Admin Login Card */}
      <div style={{
        width: '100%', maxWidth: 360,
        background: '#ffffff', border: `1px solid ${B}`,
        borderRadius: 18, padding: '32px 28px',
        boxShadow: '0 4px 24px rgba(0,0,0,0.04)',
      }}>
        {error && (
          <div style={{
            padding: '11px 14px', borderRadius: 8, marginBottom: 18,
            background: '#fef2f2', border: '1px solid #fecaca',
            color: '#b91c1c', fontSize: '0.83rem', fontWeight: 600,
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} autoComplete="off">
          <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: M, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>
            Email Address
          </label>
          <input
            type="text"
            inputMode="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="admin@provider.co.za"
            required
            autoComplete="off"
            data-lpignore="true"
            data-form-type="other"
            autoFocus
            spellCheck={false}
            style={field}
            onFocus={e => { e.currentTarget.style.borderColor = G; e.currentTarget.style.background = '#fff'; e.currentTarget.style.boxShadow = `0 0 0 3px rgba(16,185,129,0.12)`; }}
            onBlur={e => { e.currentTarget.style.borderColor = B; e.currentTarget.style.background = '#f8fafc'; e.currentTarget.style.boxShadow = 'none'; }}
          />

          <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: M, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>
            Password
          </label>
          <input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="••••••••" required autoComplete="new-password"
            data-lpignore="true"
            data-form-type="other"
            style={{ ...field, marginBottom: 24 }}
            onFocus={e => { e.currentTarget.style.borderColor = G; e.currentTarget.style.background = '#fff'; e.currentTarget.style.boxShadow = `0 0 0 3px rgba(16,185,129,0.12)`; }}
            onBlur={e => { e.currentTarget.style.borderColor = B; e.currentTarget.style.background = '#f8fafc'; e.currentTarget.style.boxShadow = 'none'; }}
          />

          <button type="submit" disabled={loading} style={{
            width: '100%', padding: '13px',
            background: loading ? '#94a3b8' : `linear-gradient(135deg, ${G}, ${GD})`,
            color: '#fff', border: 'none', borderRadius: 10,
            fontSize: '0.95rem', fontWeight: 700, cursor: loading ? 'wait' : 'pointer',
            letterSpacing: '0.02em', transition: 'all 0.2s',
          }}>
            {loading ? 'Signing In...' : 'Sign In as Admin'}
          </button>
        </form>
      </div>

      {/* Crew separator */}
      <div style={{ marginTop: 20, width: '100%', maxWidth: 360 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0 14px' }}>
          <div style={{ flex: 1, height: 1, background: B }} />
          <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Crew Access</span>
          <div style={{ flex: 1, height: 1, background: B }} />
        </div>
        <button
          onClick={() => navigate(`/${providerSlug}/crew/dashboard`)}
          style={{
            width: '100%', padding: '13px',
            background: '#ffffff', border: `1px solid ${B}`,
            borderRadius: 10, color: GD, fontSize: '0.92rem',
            fontWeight: 700, cursor: 'pointer', letterSpacing: '0.02em',
            boxShadow: '0 2px 8px rgba(0,0,0,0.02)', transition: 'all 0.2s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = G; e.currentTarget.style.background = '#f0fdf4'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = B; e.currentTarget.style.background = '#ffffff'; }}
        >
          Start Shift
        </button>
      </div>

      <p style={{ color: '#94a3b8', fontSize: '0.72rem', marginTop: 36, textAlign: 'center', fontWeight: 500, letterSpacing: '0.02em' }}>
        EMS Claims Portal • Secure Access
      </p>
    </div>
  );
}
