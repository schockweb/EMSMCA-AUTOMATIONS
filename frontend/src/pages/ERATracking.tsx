import { useState, useEffect } from 'react';
import api from '../api/client';

interface Case {
  id: string;
  file_name?: string;
  original_filename?: string;
  extracted_data?: Record<string, any>;
  patient_name: string;
  patient_id_number?: string;
  patient_dob?: string;
  medical_scheme_name?: string;
  scheme_member_number?: string;
  incident_date?: string;
  incident_location?: string;
  preauth_number?: string;
  preauth_status: string;
  dependant_code?: string;
  dispatch_type?: string;
  referring_doctor_pr?: string;
  created_at: string;
}

export default function ERATracking() {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  // Payout Summary State
  const [stats, setStats] = useState({
    total_pending: 0,
    total_reconciled: 0,
    avg_turnaround: '4.2 Days'
  });

  // Formatting state matching Admin Queue
  const [prfNameTemplate, setPrfNameTemplate] = useState<string[]>(['provider_practice_number', 'prf_number', 'medical_scheme']);
  const nameSeparator = localStorage.getItem('prf_name_separator') || ' • ';

  useEffect(() => {
    fetchCases();
    // Load PRF name template from settings
    api.get('/api/knowledge-base/extraction-settings')
       .then(res => {
         if (res.data.prf_name_template) setPrfNameTemplate(res.data.prf_name_template);
       })
       .catch(() => {});
  }, []);

  const getPrfDisplayName = (c: Case): string => {
    const data = c.extracted_data;
    if (!data) return c.original_filename || c.file_name || 'Unknown File';
    const parts = prfNameTemplate
      .map(key => (data[key] || '').toString().trim())
      .filter(Boolean);
    return parts.length > 0 ? parts.join(nameSeparator) : c.original_filename || c.file_name || 'Unknown File';
  };

  const fetchCases = async () => {
    try {
      setLoading(true);
      const res = await api.get('/api/cases/?queue=era');
      setCases(res.data);
      
      // Mock stats based on data
      setStats({
        total_pending: res.data.length,
        total_reconciled: Math.floor(res.data.length * 0.4),
        avg_turnaround: '3.8 Days'
      });
    } catch (err: any) {
      setError(err.message || 'Failed to fetch ERA tracking cases');
    } finally {
      setLoading(false);
    }
  };

  const filteredCases = cases.filter(c => 
    getPrfDisplayName(c).toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.original_filename?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.medical_scheme_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.preauth_number?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="page-content" style={{ 
      animation: 'fadeInUp 0.6s ease-out', 
      maxWidth: 1400, 
      margin: '0 auto', 
      padding: '40px 24px' 
    }}>
      
      {/* Header Section */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'flex-start', 
        marginBottom: 40 
      }}>
        <div style={{ flex: 1 }}>
          <h1 className="page-title" style={{ 
            fontSize: '2.4rem', 
            fontWeight: 800,
            letterSpacing: '-0.02em',
            margin: '0 0 24px 0',
            background: 'linear-gradient(135deg, var(--brand-teal), var(--brand-magenta))', 
            WebkitBackgroundClip: 'text', 
            WebkitTextFillColor: 'transparent' 
          }}>
            Remittance Tracking
          </h1>
          
          <div style={{ display: 'flex', gap: 16 }}>
             <div style={{ position: 'relative' }}>
               <input 
                 type="text" 
                 className="input" 
                 placeholder="Search by patient, scheme or auth..." 
                 style={{ 
                   width: 440, 
                   borderRadius: 14, 
                   padding: '12px 16px 12px 44px', 
                   background: 'var(--surface-50)',
                   border: '1px solid var(--glass-border)',
                   fontSize: '0.95rem',
                   boxShadow: '0 4px 12px rgba(0,0,0,0.03)'
                 }}
                 value={searchTerm}
                 onChange={(e) => setSearchTerm(e.target.value)}
               />
               <span style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }}>🔍</span>
             </div>
             <button className="btn btn-secondary" onClick={fetchCases} style={{ borderRadius: 14, padding: '0 20px', height: 46 }}>
               Refresh
             </button>
          </div>
        </div>

        {/* Stats Tile on the Right */}
        <div style={{ marginLeft: 40 }}>
           <div className="card" style={{ 
             padding: '20px 32px', 
             border: '1px solid var(--glass-border)', 
             borderRadius: 20,
             minWidth: 260,
             background: 'rgba(8,131,149,0.03)',
             textAlign: 'center'
           }}>
             <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Awaiting Payout</div>
             <div style={{ fontSize: '2.5rem', fontWeight: 800, color: 'var(--brand-teal)' }}>{stats.total_pending}</div>
           </div>
        </div>
      </div>

      {error && (
        <div style={{ 
          padding: '16px 24px', 
          background: 'rgba(239,68,68,0.08)', 
          color: 'var(--danger-500)', 
          borderRadius: 16, 
          marginBottom: 32, 
          border: '1px solid rgba(239,68,68,0.2)',
          display: 'flex',
          alignItems: 'center',
          gap: 12
        }}>
          <span style={{ fontSize: '1.2rem' }}>⚠️</span> {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 100, display: 'flex', justifyContent: 'center' }}>
           <div className="spinner" style={{ width: 60, height: 60, borderWidth: 4 }}></div>
        </div>
      ) : (
        <div className="card" style={{ 
          padding: 0, 
          overflow: 'hidden', 
          border: '1px solid var(--glass-border)', 
          borderRadius: 24,
          boxShadow: '0 20px 40px rgba(0,0,0,0.04)'
        }}>
          {filteredCases.length === 0 ? (
            <div style={{ padding: 100, textAlign: 'center' }}>
               <div style={{ fontSize: '3rem', marginBottom: 20 }}>🎉</div>
               <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)', marginBottom: 8 }}>{cases.length === 0 ? 'Clear Waters' : 'No matches found'}</h3>
               <p style={{ color: 'var(--text-muted)' }}>{cases.length === 0 ? 'All authorized claims have been fully reconciled.' : 'Try adjusting your search filters.'}</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead>
                  <tr style={{ background: 'var(--surface-50)', borderBottom: '1px solid var(--surface-200)' }}>
                    <th style={{ padding: '20px 24px', fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Claim Details</th>
                    <th style={{ padding: '20px 24px', fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Medical Scheme</th>
                    <th style={{ padding: '20px 24px', fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Incident Date</th>
                    <th style={{ padding: '20px 24px', fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Authorization</th>
                    <th style={{ padding: '20px 24px', fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCases.map((c, i) => (
                    <tr key={c.id} style={{ 
                      borderBottom: i === filteredCases.length - 1 ? 'none' : '1px solid var(--surface-100)',
                      transition: 'all 0.2s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(8,131,149,0.02)'}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <td style={{ padding: '24px' }}>
                        <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--brand-teal)', marginBottom: 4 }}>
                           {getPrfDisplayName(c)}
                        </div>
                        {c.original_filename && (
                           <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ opacity: 0.6 }}>📄</span> {c.original_filename}
                           </div>
                        )}
                      </td>
                      <td style={{ padding: '24px' }}>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{c.medical_scheme_name || 'Private / Uninsured'}</div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                          <span style={{ background: 'var(--surface-100)', padding: '2px 8px', borderRadius: 6, marginRight: 6 }}>Member</span>
                          {c.scheme_member_number || 'N/A'}
                        </div>
                      </td>
                      <td style={{ padding: '24px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontWeight: 600 }}>{c.incident_date ? new Date(c.incident_date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : 'N/A'}</span>
                          <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>Claim created {new Date(c.created_at).toLocaleDateString()}</span>
                        </div>
                      </td>
                      <td style={{ padding: '24px' }}>
                         <div style={{ 
                           display: 'inline-flex', 
                           alignItems: 'center', 
                           gap: 8, 
                           padding: '6px 14px', 
                           background: 'rgba(8,131,149,0.06)', 
                           borderRadius: 10,
                           border: '1px solid rgba(8,131,149,0.1)'
                         }}>
                           <span style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--brand-teal)', fontFamily: 'monospace' }}>
                             {c.preauth_number}
                           </span>
                         </div>
                      </td>
                      <td style={{ padding: '24px' }}>
                        <div style={{ 
                          display: 'inline-flex', 
                          alignItems: 'center', 
                          gap: 8, 
                          padding: '6px 12px', 
                          borderRadius: 999,
                          fontSize: '0.75rem', 
                          fontWeight: 700,
                          color: '#b45309', 
                          background: 'rgba(251, 191, 36, 0.12)',
                          border: '1px solid rgba(251, 191, 36, 0.2)'
                        }}>
                          <span className="pulse" style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b' }}></span>
                          AWAITING REMITTANCE
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
