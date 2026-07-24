/**
 * LockedAccounts — admin view of provider + crew accounts currently locked out
 * after too many failed logins. The admin phones the provider to verify it was
 * genuinely them, then clicks Unlock to clear the lockout so they can get back
 * into their ePRF without waiting out the timer.
 */
import { useEffect, useState, useCallback } from 'react';
import api from '../api/client';

interface LockedAccount {
  account_type: 'provider' | 'crew';
  id: string;
  name: string;
  login_email: string | null;
  phone: string | null;
  provider_name: string | null;
  failed_attempts: number;
  locked_until: string | null;
}

const fmtWhen = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const mins = Math.max(0, Math.round((d.getTime() - now.getTime()) / 60000));
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${t} · ${mins} min left`;
};

export default function LockedAccounts() {
  const [rows, setRows] = useState<LockedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [unlocking, setUnlocking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await api.get('/api/account-security/locked');
      setRows(res.data || []);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || 'Could not load locked accounts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const unlock = async (a: LockedAccount) => {
    if (!window.confirm(`Unlock ${a.name}? Only do this once you've confirmed by phone that the lockout was genuinely them.`)) return;
    setUnlocking(a.id);
    try {
      await api.post('/api/account-security/unlock', { account_type: a.account_type, id: a.id });
      setRows(prev => prev.filter(r => !(r.id === a.id && r.account_type === a.account_type)));
    } catch (e: any) {
      alert(e?.response?.data?.detail || 'Unlock failed.');
    } finally {
      setUnlocking(null);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Locked Accounts</h1>
        <button onClick={load} className="btn btn-secondary" style={{ fontSize: '0.82rem' }}>↻ Refresh</button>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', marginTop: 0, marginBottom: 20 }}>
        Provider and crew logins locked after too many failed attempts. Phone the
        person to confirm it was really them, then unlock so they can sign in.
      </p>

      {err && <div className="login-error" style={{ marginBottom: 16 }}>{err}</div>}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{
          padding: 48, textAlign: 'center', borderRadius: 14,
          border: '1.5px dashed var(--glass-border)', color: 'var(--text-muted)',
        }}>
          ✓ No accounts are currently locked.
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--glass-border)', borderRadius: 14 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'var(--surface-100, #f8fafc)', textAlign: 'left' }}>
                {['Name', 'Type', 'Client', 'Login email', 'Phone', 'Fails', 'Locked until', ''].map(h => (
                  <th key={h} style={{ padding: '11px 14px', fontSize: '0.72rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(a => (
                <tr key={`${a.account_type}:${a.id}`} style={{ borderTop: '1px solid var(--glass-border)' }}>
                  <td style={{ padding: '11px 14px', fontWeight: 700, color: 'var(--text-primary)' }}>{a.name}</td>
                  <td style={{ padding: '11px 14px' }}>
                    <span style={{
                      fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
                      padding: '3px 8px', borderRadius: 6,
                      background: a.account_type === 'provider' ? '#e0f2fe' : '#f1f5f9',
                      color: a.account_type === 'provider' ? '#0369a1' : '#475569',
                    }}>{a.account_type}</span>
                  </td>
                  <td style={{ padding: '11px 14px', color: 'var(--text-secondary)' }}>{a.provider_name || '—'}</td>
                  <td style={{ padding: '11px 14px', color: 'var(--text-secondary)' }}>{a.login_email || '—'}</td>
                  <td style={{ padding: '11px 14px', color: 'var(--text-secondary)' }}>
                    {a.phone ? <a href={`tel:${a.phone}`} style={{ color: 'var(--brand-teal)' }}>{a.phone}</a> : '—'}
                  </td>
                  <td style={{ padding: '11px 14px', color: '#b91c1c', fontWeight: 700 }}>{a.failed_attempts}</td>
                  <td style={{ padding: '11px 14px', color: 'var(--text-secondary)' }}>{fmtWhen(a.locked_until)}</td>
                  <td style={{ padding: '11px 14px', textAlign: 'right' }}>
                    <button
                      onClick={() => unlock(a)}
                      disabled={unlocking === a.id}
                      className="btn btn-primary"
                      style={{ fontSize: '0.78rem', padding: '7px 14px', opacity: unlocking === a.id ? 0.6 : 1 }}
                    >
                      {unlocking === a.id ? 'Unlocking…' : 'Unlock'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
