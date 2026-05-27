/**
 * ProviderManagement — Admin page to manage Service Providers, Crew, and Vehicles.
 * Accessible from the admin sidebar.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

interface Provider {
  id: string;
  name: string;
  slug: string;
  pr_number: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  is_active: boolean;
  crew_count: number;
  vehicle_count: number;
  prf_count: number;
  created_at: string | null;
}

interface CrewMember {
  id: string;
  email: string;
  full_name: string;
  initials: string | null;
  hpcsa_number: string | null;
  qualification: string;
  phone: string | null;
  is_active: boolean;
  last_login: string | null;
}

interface Vehicle {
  id: string;
  callsign: string;
  registration: string;
  vehicle_type: string;
  is_active: boolean;
}

const teal = '#088395';
const rose = '#C2185B';

export default function ProviderManagement() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal states
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [activeTab, setActiveTab] = useState<'crew' | 'vehicles'>('crew');

  // Crew/Vehicle lists for selected provider
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [crewLoading, setCrewLoading] = useState(false);

  // Add forms
  const [newProvider, setNewProvider] = useState({ name: '', pr_number: '', phone: '', email: '', address: '' });
  const [newCrew, setNewCrew] = useState({ full_name: '', email: '', initials: '', hpcsa_number: '', qualification: 'ILS', phone: '' });
  const [newVehicle, setNewVehicle] = useState({ callsign: '', registration: '', vehicle_type: 'Ambulance' });
  const [showAddCrew, setShowAddCrew] = useState(false);
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [tempPassword, setTempPassword] = useState('');

  const fetchProviders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/providers');
      setProviders(res.data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchProviders(); }, [fetchProviders]);

  const fetchProviderDetails = async (provider: Provider) => {
    setSelectedProvider(provider);
    setCrewLoading(true);
    try {
      const [crewRes, vehicleRes] = await Promise.all([
        api.get(`/api/providers/${provider.id}/crew`),
        api.get(`/api/providers/${provider.id}/vehicles`),
      ]);
      setCrew(crewRes.data);
      setVehicles(vehicleRes.data);
    } catch { /* ignore */ }
    setCrewLoading(false);
  };

  const handleAddProvider = async () => {
    try {
      await api.post('/api/providers', newProvider);
      setShowAddProvider(false);
      setNewProvider({ name: '', pr_number: '', phone: '', email: '', address: '' });
      fetchProviders();
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to create provider');
    }
  };

  const handleAddCrew = async () => {
    if (!selectedProvider) return;
    try {
      const res = await api.post(`/api/providers/${selectedProvider.id}/crew`, newCrew);
      setTempPassword(res.data.temp_password);
      setNewCrew({ full_name: '', email: '', initials: '', hpcsa_number: '', qualification: 'ILS', phone: '' });
      fetchProviderDetails(selectedProvider);
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to add crew member');
    }
  };

  const handleAddVehicle = async () => {
    if (!selectedProvider) return;
    try {
      await api.post(`/api/providers/${selectedProvider.id}/vehicles`, newVehicle);
      setShowAddVehicle(false);
      setNewVehicle({ callsign: '', registration: '', vehicle_type: 'Ambulance' });
      fetchProviderDetails(selectedProvider);
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to add vehicle');
    }
  };

  const handleDeleteCrew = async (crewId: string) => {
    if (!selectedProvider) return;
    if (!window.confirm('Are you sure you want to delete this crew member?')) return;
    try {
      await api.delete(`/api/providers/${selectedProvider.id}/crew/${crewId}`);
      fetchProviderDetails(selectedProvider);
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to delete crew member');
    }
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--surface-50)',
    borderRadius: 12,
    border: '1px solid var(--surface-100)',
    padding: 20,
    marginBottom: 16,
  };

  const btnPrimary: React.CSSProperties = {
    background: `linear-gradient(135deg, ${teal}, #0a9396)`,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '8px 18px',
    fontSize: '0.82rem',
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: '0.03em',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontSize: '0.84rem',
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid var(--surface-200)',
    background: 'var(--bg)',
    color: 'var(--text)',
    marginBottom: 8,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '0.68rem',
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 3,
    display: 'block',
  };

  // ── Provider List View ──
  if (!selectedProvider) {
    return (
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--text)' }}>
              🏥 Service Providers
            </h1>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Manage EMS companies, crew members, and vehicles
            </p>
          </div>
          <button style={btnPrimary} onClick={() => setShowAddProvider(true)}>+ Add Provider</button>
        </div>

        {/* Add Provider Modal */}
        {showAddProvider && (
          <div style={cardStyle}>
            <h3 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: 12, color: teal }}>New Service Provider</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label style={labelStyle}>Company Name *</label><input style={inputStyle} placeholder="e.g. JEMS Medical Services" value={newProvider.name} onChange={e => setNewProvider({ ...newProvider, name: e.target.value })} /></div>
              <div><label style={labelStyle}>PR Number</label><input style={inputStyle} placeholder="e.g. 009 003 074661" value={newProvider.pr_number} onChange={e => setNewProvider({ ...newProvider, pr_number: e.target.value })} /></div>
              <div><label style={labelStyle}>Phone</label><input style={inputStyle} placeholder="e.g. 078 670 6945" value={newProvider.phone} onChange={e => setNewProvider({ ...newProvider, phone: e.target.value })} /></div>
              <div><label style={labelStyle}>Email</label><input style={inputStyle} placeholder="e.g. admin@jems.co.za" value={newProvider.email} onChange={e => setNewProvider({ ...newProvider, email: e.target.value })} /></div>
            </div>
            <div style={{ marginTop: 8 }}><label style={labelStyle}>Address</label><input style={inputStyle} placeholder="Full address" value={newProvider.address} onChange={e => setNewProvider({ ...newProvider, address: e.target.value })} /></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button style={btnPrimary} onClick={handleAddProvider}>Create Provider</button>
              <button style={{ ...btnPrimary, background: 'var(--surface-200)', color: 'var(--text)' }} onClick={() => setShowAddProvider(false)}>Cancel</button>
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading providers...</div>
        ) : providers.length === 0 ? (
          <div style={{ ...cardStyle, textAlign: 'center', padding: 40 }}>
            <p style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>No service providers yet</p>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>Click "Add Provider" to onboard your first EMS company.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {providers.map(p => (
              <div key={p.id} style={{ ...cardStyle, cursor: 'pointer', transition: 'border-color 0.15s', marginBottom: 0 }} onClick={() => fetchProviderDetails(p)}
                onMouseEnter={e => (e.currentTarget.style.borderColor = teal)}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--surface-100)')}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text)' }}>{p.name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                      /{p.slug}/crew • PR: {p.pr_number || '—'} • {p.phone || '—'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                    {[
                      { label: 'Crew', val: p.crew_count, color: teal },
                      { label: 'Vehicles', val: p.vehicle_count, color: '#E65100' },
                      { label: 'PRFs', val: p.prf_count, color: rose },
                    ].map(s => (
                      <div key={s.label} style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.2rem', fontWeight: 800, color: s.color }}>{s.val}</div>
                        <div style={{ fontSize: '0.6rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Provider Detail View (Crew + Vehicles) ──
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button onClick={() => { setSelectedProvider(null); fetchProviders(); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: teal }}>←</button>
        <div>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 800, margin: 0, color: 'var(--text)' }}>{selectedProvider.name}</h1>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
            /{selectedProvider.slug}/crew • PR: {selectedProvider.pr_number || '—'} • {selectedProvider.phone || '—'}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid var(--surface-100)', paddingBottom: 0 }}>
        {(['crew', 'vehicles'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            padding: '8px 20px', fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer',
            border: 'none', borderBottom: activeTab === tab ? `2px solid ${teal}` : '2px solid transparent',
            background: 'transparent', color: activeTab === tab ? teal : 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>
            {tab === 'crew' ? `👥 Crew (${crew.length})` : `🚑 Vehicles (${vehicles.length})`}
          </button>
        ))}
      </div>

      {crewLoading ? (
        <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>Loading...</div>
      ) : activeTab === 'crew' ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{crew.length} crew member{crew.length !== 1 ? 's' : ''}</span>
            <button style={btnPrimary} onClick={() => { setShowAddCrew(true); setTempPassword(''); }}>+ Add Crew</button>
          </div>

          {showAddCrew && (
            <div style={cardStyle}>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: teal, marginBottom: 10 }}>Add Crew Member</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div><label style={labelStyle}>Full Name *</label><input style={inputStyle} placeholder="e.g. A. Ishwar" value={newCrew.full_name} onChange={e => setNewCrew({ ...newCrew, full_name: e.target.value })} /></div>
                <div><label style={labelStyle}>Email *</label><input style={inputStyle} placeholder="crew@email.com" value={newCrew.email} onChange={e => setNewCrew({ ...newCrew, email: e.target.value })} /></div>
                <div><label style={labelStyle}>Initials</label><input style={inputStyle} placeholder="A.I." value={newCrew.initials} onChange={e => setNewCrew({ ...newCrew, initials: e.target.value })} /></div>
                <div><label style={labelStyle}>HPCSA Number</label><input style={inputStyle} placeholder="0049530" value={newCrew.hpcsa_number} onChange={e => setNewCrew({ ...newCrew, hpcsa_number: e.target.value })} /></div>
                <div>
                  <label style={labelStyle}>Qualification</label>
                  <select style={inputStyle} value={newCrew.qualification} onChange={e => setNewCrew({ ...newCrew, qualification: e.target.value })}>
                    <option value="BLS">BLS</option>
                    <option value="ILS">ILS</option>
                    <option value="ALS">ALS</option>
                  </select>
                </div>
                <div><label style={labelStyle}>Phone</label><input style={inputStyle} placeholder="082 123 4567" value={newCrew.phone} onChange={e => setNewCrew({ ...newCrew, phone: e.target.value })} /></div>
              </div>
              {tempPassword && (
                <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(8,131,149,0.08)', border: `1px solid rgba(8,131,149,0.2)`, marginTop: 10 }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: teal, textTransform: 'uppercase' }}>Temporary Password</div>
                  <div style={{ fontSize: '1rem', fontWeight: 800, fontFamily: 'monospace', color: 'var(--text)', marginTop: 4 }}>{tempPassword}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>Share this securely with the crew member.</div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button style={btnPrimary} onClick={handleAddCrew}>Add Crew Member</button>
                <button style={{ ...btnPrimary, background: 'var(--surface-200)', color: 'var(--text)' }} onClick={() => setShowAddCrew(false)}>Close</button>
              </div>
            </div>
          )}

          {/* Crew Table */}
          <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--surface-100)', textAlign: 'left' }}>
                  <th style={{ padding: '10px 14px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Name</th>
                  <th style={{ padding: '10px 14px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>HPCSA #</th>
                  <th style={{ padding: '10px 14px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Qual</th>
                  <th style={{ padding: '10px 14px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Email</th>
                  <th style={{ padding: '10px 14px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Status</th>
                  <th style={{ padding: '10px 14px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {crew.map(c => (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--surface-100)' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>{c.full_name}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: '0.8rem' }}>{c.hpcsa_number || '—'}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 99, fontSize: '0.7rem', fontWeight: 700,
                        background: c.qualification === 'ALS' ? 'rgba(194,24,91,0.1)' : 'rgba(8,131,149,0.1)',
                        color: c.qualification === 'ALS' ? rose : teal }}>
                        {c.qualification}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>{c.email}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.is_active ? '#4caf50' : '#e53e3e', display: 'inline-block' }} />
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                      <button 
                        onClick={() => handleDeleteCrew(c.id)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: rose, fontSize: '0.75rem', fontWeight: 700 }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {crew.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No crew members yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{vehicles.length} vehicle{vehicles.length !== 1 ? 's' : ''}</span>
            <button style={btnPrimary} onClick={() => setShowAddVehicle(true)}>+ Add Vehicle</button>
          </div>

          {showAddVehicle && (
            <div style={cardStyle}>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: '#E65100', marginBottom: 10 }}>Add Vehicle</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div><label style={labelStyle}>Callsign *</label><input style={inputStyle} placeholder="e.g. ALPHA 12" value={newVehicle.callsign} onChange={e => setNewVehicle({ ...newVehicle, callsign: e.target.value })} /></div>
                <div><label style={labelStyle}>Registration *</label><input style={inputStyle} placeholder="e.g. GP 123-456" value={newVehicle.registration} onChange={e => setNewVehicle({ ...newVehicle, registration: e.target.value })} /></div>
                <div>
                  <label style={labelStyle}>Type</label>
                  <select style={inputStyle} value={newVehicle.vehicle_type} onChange={e => setNewVehicle({ ...newVehicle, vehicle_type: e.target.value })}>
                    <option value="Ambulance">Ambulance</option>
                    <option value="Response Vehicle">Response Vehicle</option>
                    <option value="Helicopter">Helicopter</option>
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button style={btnPrimary} onClick={handleAddVehicle}>Add Vehicle</button>
                <button style={{ ...btnPrimary, background: 'var(--surface-200)', color: 'var(--text)' }} onClick={() => setShowAddVehicle(false)}>Cancel</button>
              </div>
            </div>
          )}

          {/* Vehicle Table */}
          <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--surface-100)', textAlign: 'left' }}>
                  <th style={{ padding: '10px 14px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Callsign</th>
                  <th style={{ padding: '10px 14px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Registration</th>
                  <th style={{ padding: '10px 14px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Type</th>
                  <th style={{ padding: '10px 14px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map(v => (
                  <tr key={v.id} style={{ borderBottom: '1px solid var(--surface-100)' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 700 }}>🚑 {v.callsign}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'monospace' }}>{v.registration}</td>
                    <td style={{ padding: '10px 14px' }}>{v.vehicle_type}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: v.is_active ? '#4caf50' : '#e53e3e', display: 'inline-block' }} />
                    </td>
                  </tr>
                ))}
                {vehicles.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No vehicles yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
