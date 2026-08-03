/**
 * The operator's fault queue — what is wrong, what the system proposes, approve or dismiss.
 *
 * Sits above the crash list on System Health because it answers a different
 * question. A crash says something threw; a fault says a condition the platform
 * depends on is currently false, which is how most of this system's real
 * outages have looked — nothing threw, a part just quietly stopped working.
 *
 * Deliberate UI choices:
 *  - The reason a fix is WAITING is shown as prominently as the fix itself.
 *    "Why is this asking me?" should never need a support call.
 *  - Approve is never the default-styled button on a CRITICAL row. The operator
 *    should read before clicking, and visual momentum is how that stops.
 *  - Self-healed items are shown, not hidden. An automatic repair the operator
 *    never sees is indistinguishable from a system that is quietly degrading.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

interface Fault {
  id: string;
  fault_key: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: string;
  evidence: Record<string, unknown> | null;
  remedy_key: string | null;
  remedy_description: string | null;
  auto_eligible: boolean;
  decision_reason: string | null;
  attempts: number;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  outcome: string | null;
  can_apply: boolean;
}

interface Summary {
  open: number;
  by_severity: Record<string, number>;
  awaiting_approval: number;
  self_healed_last_24h: number;
  worst: string | null;
}

const SEV: Record<string, { color: string; bg: string; label: string }> = {
  critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.10)', label: 'CRITICAL' },
  high:     { color: '#f59e0b', bg: 'rgba(245,158,11,0.10)', label: 'HIGH' },
  medium:   { color: '#3b82f6', bg: 'rgba(59,130,246,0.10)', label: 'MEDIUM' },
  low:      { color: '#6b7280', bg: 'rgba(107,114,128,0.10)', label: 'LOW' },
};

export default function FaultQueue() {
  const [faults, setFaults] = useState<Fault[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [f, s] = await Promise.all([
        api.get('/api/system-faults', { params: { include_resolved: showHistory } }),
        api.get('/api/system-faults/summary'),
      ]);
      setFaults(f.data);
      setSummary(s.data);
    } finally {
      setLoading(false);
    }
  }, [showHistory]);

  useEffect(() => {
    fetchData();
    // 60s: the sweep itself runs every 5 minutes, so polling faster only adds
    // load without adding information.
    const t = setInterval(fetchData, 60_000);
    return () => clearInterval(t);
  }, [fetchData]);

  const approve = async (f: Fault) => {
    // A typed confirmation rather than a plain OK/Cancel. This executes code
    // against production; the friction is the point.
    if (!window.confirm(
      `Apply this fix now?\n\n${f.title}\n\nFix: ${f.remedy_description}\n\n` +
      `This runs immediately against production and is recorded in the audit log against your account.`
    )) return;
    setBusyId(f.id);
    try {
      const res = await api.post(`/api/system-faults/${f.id}/approve`, {});
      const r: Fault = res.data;
      window.alert(
        r.status === 'resolved'
          ? `Fixed.\n\n${r.outcome || ''}`
          : `The fix did not clear the fault.\n\n${r.outcome || ''}\n\nIt has NOT been retried automatically.`
      );
      fetchData();
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = async (f: Fault) => {
    const reason = window.prompt(
      `Dismiss "${f.title}" without running the fix?\n\n` +
      `Give a reason — it is recorded, and if the condition is still true the ` +
      `next sweep will raise it again.`
    );
    if (!reason || !reason.trim()) return;
    setBusyId(f.id);
    try {
      await api.post(`/api/system-faults/${f.id}/dismiss`, { reason });
      fetchData();
    } finally {
      setBusyId(null);
    }
  };

  const runSweep = async () => {
    setBusyId('sweep');
    try {
      const res = await api.post('/api/system-faults/sweep');
      const d = res.data;
      window.alert(
        `Checked ${d.checked} conditions.\n\n` +
        `${d.faults} fault(s) found\n` +
        `${d.auto_healed} fixed automatically\n` +
        `${d.awaiting_approval} waiting for you\n` +
        `${d.inconclusive} could not be determined`
      );
      fetchData();
    } finally {
      setBusyId(null);
    }
  };

  const timeAgo = (iso: string) => {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
  };

  if (loading) return null;

  const allClear = (summary?.open ?? 0) === 0;

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Faults &amp; Self-Healing</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary, #9ca3af)' }}>
            Conditions the platform checks every few minutes. It fixes what it safely can and asks you about the rest.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={showHistory} onChange={e => setShowHistory(e.target.checked)} />
            Show history
          </label>
          <button className="btn btn-secondary" onClick={runSweep} disabled={busyId === 'sweep'}>
            {busyId === 'sweep' ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>

      {/* Summary strip */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Stat label="Open faults" value={summary?.open ?? 0}
              color={allClear ? '#10b981' : SEV[summary?.worst || 'low'].color} />
        <Stat label="Waiting for you" value={summary?.awaiting_approval ?? 0}
              color={(summary?.awaiting_approval ?? 0) > 0 ? '#f59e0b' : '#6b7280'} />
        <Stat label="Fixed automatically (24h)" value={summary?.self_healed_last_24h ?? 0} color="#10b981" />
      </div>

      {allClear && !showHistory && (
        <div style={{
          padding: '20px 24px', borderRadius: 16, background: 'rgba(16,185,129,0.08)',
          border: '1px solid rgba(16,185,129,0.35)', color: '#10b981', fontWeight: 600,
        }}>
          All checks passing. Nothing needs your attention.
        </div>
      )}

      {faults.map(f => {
        const sev = SEV[f.severity] || SEV.low;
        const open = expanded === f.id;
        const settled = ['auto_healed', 'resolved', 'dismissed', 'cleared'].includes(f.status);
        return (
          <div key={f.id} style={{
            border: `1px solid ${settled ? 'rgba(107,114,128,0.3)' : sev.color}`,
            background: settled ? 'transparent' : sev.bg,
            borderRadius: 14, padding: '16px 20px', marginBottom: 10, opacity: settled ? 0.65 : 1,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 10, fontWeight: 800, letterSpacing: 1, padding: '3px 8px',
                    borderRadius: 6, color: sev.color, border: `1px solid ${sev.color}`,
                  }}>{sev.label}</span>
                  <strong style={{ fontSize: 15 }}>{f.title}</strong>
                  {f.status === 'auto_healed' && (
                    <span style={{ fontSize: 11, color: '#10b981', fontWeight: 700 }}>FIXED AUTOMATICALLY</span>
                  )}
                  {f.status === 'remedy_failed' && (
                    <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 700 }}>FIX FAILED</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #9ca3af)', marginTop: 6 }}>
                  seen {f.occurrences}× · first {timeAgo(f.first_seen_at)} · last {timeAgo(f.last_seen_at)}
                  {f.attempts > 0 && ` · ${f.attempts} fix attempt${f.attempts > 1 ? 's' : ''}`}
                </div>

                {f.remedy_description && (
                  <div style={{ marginTop: 10, fontSize: 13 }}>
                    <span style={{ color: 'var(--text-secondary, #9ca3af)' }}>Proposed fix: </span>
                    {f.remedy_description}
                  </div>
                )}

                {/* Why this is waiting — as prominent as the fix itself. */}
                {!settled && f.decision_reason && (
                  <div style={{
                    marginTop: 10, fontSize: 12.5, padding: '10px 12px', borderRadius: 10,
                    background: 'rgba(148,163,184,0.10)', borderLeft: '3px solid rgba(148,163,184,0.6)',
                  }}>
                    <strong>Why this needs you: </strong>{f.decision_reason}
                  </div>
                )}

                {f.outcome && (
                  <div style={{ marginTop: 8, fontSize: 12.5, color: settled ? '#10b981' : '#ef4444' }}>
                    {f.outcome}
                  </div>
                )}
              </div>

              {!settled && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  {f.can_apply && (
                    <button
                      onClick={() => approve(f)}
                      disabled={busyId === f.id}
                      /* Never the loud primary button on a CRITICAL row — the
                         operator should read first. */
                      className={f.severity === 'critical' ? 'btn btn-secondary' : 'btn btn-primary'}
                    >
                      {busyId === f.id ? 'Applying…' : 'Apply fix'}
                    </button>
                  )}
                  <button className="btn btn-secondary" onClick={() => dismiss(f)} disabled={busyId === f.id}>
                    Dismiss
                  </button>
                </div>
              )}
            </div>

            {f.evidence && Object.keys(f.evidence).length > 0 && (
              <>
                <button
                  onClick={() => setExpanded(open ? null : f.id)}
                  style={{
                    marginTop: 10, background: 'none', border: 'none', padding: 0,
                    color: 'var(--primary-400, #60a5fa)', fontSize: 12, cursor: 'pointer',
                  }}
                >
                  {open ? 'Hide details' : 'What was measured'}
                </button>
                {open && (
                  <pre style={{
                    marginTop: 8, fontSize: 11.5, padding: 12, borderRadius: 10, overflowX: 'auto',
                    background: 'rgba(0,0,0,0.25)', color: 'var(--text-secondary, #cbd5e1)',
                  }}>{JSON.stringify(f.evidence, null, 2)}</pre>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      padding: '12px 18px', borderRadius: 12, minWidth: 150,
      border: '1px solid rgba(148,163,184,0.25)',
    }}>
      <div style={{ fontSize: 24, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-secondary, #9ca3af)' }}>
        {label}
      </div>
    </div>
  );
}
