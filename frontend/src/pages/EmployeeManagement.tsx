/**
 * Employee Management — Create accounts, assign roles, and control page-level permissions.
 */
import { useState, useEffect } from 'react';
import api from '../api/client';

interface Employee {
  id: string;
  email: string;
  full_name: string;
  role: string;
  bhf_practice_number?: string;
  is_active: boolean;
  permissions: string[];
  created_at: string;
}

interface PermissionDef {
  key: string;
  label: string;
}

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Administrator' },
  { value: 'billing_clerk', label: 'Billing Clerk' },
  { value: 'dispatcher', label: 'Dispatcher' },
  { value: 'paramedic', label: 'Paramedic' },
];

const ROLE_PRESETS: Record<string, string[]> = {
  admin: [], // admins get everything regardless
  billing_clerk: ['dashboard', 'admin_queue', 'document_review', 'adjudication', 'cases'],
  dispatcher: ['dashboard', 'upload', 'admin_queue'],
  paramedic: ['dashboard', 'upload'],
};

export default function EmployeeManagement() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [allPerms, setAllPerms] = useState<PermissionDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Create form
  const [formEmail, setFormEmail] = useState('');
  const [formName, setFormName] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState('billing_clerk');
  const [formBhf, setFormBhf] = useState('');
  const [formPerms, setFormPerms] = useState<string[]>([]);

  // Edit form
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editBhf, setEditBhf] = useState('');
  const [editPerms, setEditPerms] = useState<string[]>([]);
  const [editPassword, setEditPassword] = useState('');
  const [editActive, setEditActive] = useState(true);

  useEffect(() => {
    fetchEmployees();
    fetchPermissions();
  }, []);

  const fetchEmployees = async () => {
    try {
      const res = await api.get('/api/users/');
      setEmployees(res.data);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  };

  const fetchPermissions = async () => {
    try {
      const res = await api.get('/api/users/permissions-list');
      setAllPerms(res.data.permissions);
    } catch { /* silent */ }
  };

  const handleRoleChange = (role: string) => {
    setFormRole(role);
    if (ROLE_PRESETS[role]) {
      setFormPerms([...ROLE_PRESETS[role]]);
    }
  };

  const togglePerm = (perms: string[], key: string): string[] => {
    return perms.includes(key) ? perms.filter(p => p !== key) : [...perms, key];
  };

  const handleCreate = async () => {
    setError('');
    setSuccess('');
    if (!formEmail || !formName || !formPassword) {
      setError('Email, name, and password are required.');
      return;
    }
    try {
      await api.post('/api/users/', {
        email: formEmail,
        password: formPassword,
        full_name: formName,
        role: formRole,
        bhf_practice_number: formBhf || null,
        permissions: formRole === 'admin' ? null : formPerms,
      });
      setSuccess(`Account created for ${formName}`);
      setShowCreate(false);
      setFormEmail(''); setFormName(''); setFormPassword(''); setFormBhf('');
      setFormRole('billing_clerk'); setFormPerms([]);
      await fetchEmployees();
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to create account');
    }
  };

  const startEdit = (emp: Employee) => {
    setEditId(emp.id);
    setEditName(emp.full_name);
    setEditRole(emp.role);
    setEditBhf(emp.bhf_practice_number || '');
    setEditPerms(emp.permissions || []);
    setEditPassword('');
    setEditActive(emp.is_active);
  };

  const handleUpdate = async () => {
    if (!editId) return;
    setError('');
    setSuccess('');
    try {
      await api.patch(`/api/users/${editId}`, {
        full_name: editName,
        role: editRole,
        bhf_practice_number: editBhf || null,
        is_active: editActive,
        permissions: editRole === 'admin' ? null : editPerms,
        password: editPassword || null,
      });
      setSuccess('Employee updated successfully');
      setEditId(null);
      await fetchEmployees();
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to update employee');
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <div className="spinner" style={{ width: 40, height: 40 }} />
      </div>
    );
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
              Employee Management
            </h2>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: 4, marginBottom: 0 }}>
              Create accounts, assign roles, and control workspace visibility per employee.
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => { setShowCreate(true); handleRoleChange('billing_clerk'); }}>
            + New Employee
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 'var(--radius-md)', padding: '12px 16px', marginBottom: 16, color: '#ef4444', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}
      {success && (
        <div style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 'var(--radius-md)', padding: '12px 16px', marginBottom: 16, color: '#10b981', fontSize: '0.85rem' }}>
          {success}
        </div>
      )}

      {/* ── Create Employee Modal ── */}
      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div className="card" style={{ maxWidth: 600, width: '90%', padding: 32, maxHeight: '85vh', overflowY: 'auto' }}>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: 20, color: 'var(--text-primary)' }}>Create Employee Account</h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Full Name</label>
                <input className="form-control" value={formName} onChange={e => setFormName(e.target.value)} placeholder="John Doe" />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Email Address</label>
                <input className="form-control" value={formEmail} onChange={e => setFormEmail(e.target.value)} placeholder="john@company.co.za" />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Password</label>
                <input className="form-control" type="password" value={formPassword} onChange={e => setFormPassword(e.target.value)} placeholder="Secure password" />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>BHF Practice Number</label>
                <input className="form-control" value={formBhf} onChange={e => setFormBhf(e.target.value)} placeholder="Optional" />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Role</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {ROLE_OPTIONS.map(r => (
                  <button
                    key={r.value}
                    className={`btn ${formRole === r.value ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: '0.8rem', padding: '6px 14px' }}
                    onClick={() => handleRoleChange(r.value)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {formRole !== 'admin' && (
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 8 }}>
                  Page Permissions — Controls what this employee can see and access
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {allPerms.map(p => (
                    <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', cursor: 'pointer', padding: '6px 10px', borderRadius: 'var(--radius-sm)', background: formPerms.includes(p.key) ? 'rgba(16,185,129,0.08)' : 'transparent', border: `1px solid ${formPerms.includes(p.key) ? 'rgba(16,185,129,0.3)' : 'var(--surface-200)'}` }}>
                      <input
                        type="checkbox"
                        checked={formPerms.includes(p.key)}
                        onChange={() => setFormPerms(togglePerm(formPerms, p.key))}
                        style={{ accentColor: 'var(--brand-teal)' }}
                      />
                      {p.label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate}>Create Account</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Employee Modal ── */}
      {editId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div className="card" style={{ maxWidth: 600, width: '90%', padding: 32, maxHeight: '85vh', overflowY: 'auto' }}>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: 20, color: 'var(--text-primary)' }}>Edit Employee</h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Full Name</label>
                <input className="form-control" value={editName} onChange={e => setEditName(e.target.value)} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>BHF Practice Number</label>
                <input className="form-control" value={editBhf} onChange={e => setEditBhf(e.target.value)} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Reset Password</label>
                <input className="form-control" type="password" value={editPassword} onChange={e => setEditPassword(e.target.value)} placeholder="Leave blank to keep current" />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Status</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className={`btn ${editActive ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: '0.8rem', flex: 1 }} onClick={() => setEditActive(true)}>Active</button>
                  <button className={`btn ${!editActive ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: '0.8rem', flex: 1, background: !editActive ? '#ef4444' : undefined, borderColor: !editActive ? '#ef4444' : undefined }} onClick={() => setEditActive(false)}>Disabled</button>
                </div>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Role</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {ROLE_OPTIONS.map(r => (
                  <button
                    key={r.value}
                    className={`btn ${editRole === r.value ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: '0.8rem', padding: '6px 14px' }}
                    onClick={() => {
                      setEditRole(r.value);
                      if (ROLE_PRESETS[r.value]) setEditPerms([...ROLE_PRESETS[r.value]]);
                    }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {editRole !== 'admin' && (
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 8 }}>
                  Page Permissions
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {allPerms.map(p => (
                    <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', cursor: 'pointer', padding: '6px 10px', borderRadius: 'var(--radius-sm)', background: editPerms.includes(p.key) ? 'rgba(16,185,129,0.08)' : 'transparent', border: `1px solid ${editPerms.includes(p.key) ? 'rgba(16,185,129,0.3)' : 'var(--surface-200)'}` }}>
                      <input
                        type="checkbox"
                        checked={editPerms.includes(p.key)}
                        onChange={() => setEditPerms(togglePerm(editPerms, p.key))}
                        style={{ accentColor: 'var(--brand-teal)' }}
                      />
                      {p.label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setEditId(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleUpdate}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Employee Table ── */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--surface-200)', background: 'var(--surface-50)' }}>
              <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Employee</th>
              <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Role</th>
              <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Permissions</th>
              <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Status</th>
              <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {employees.map(emp => (
              <tr key={emp.id} style={{ borderBottom: '1px solid var(--surface-100)', opacity: emp.is_active ? 1 : 0.5 }}>
                <td style={{ padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--surface-100)', border: '1px solid var(--surface-200)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, color: 'var(--brand-teal)' }}>
                      {emp.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{emp.full_name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{emp.email}</div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: '14px 16px' }}>
                  <span className="badge" style={{ background: emp.role === 'admin' ? 'rgba(139,92,246,0.15)' : 'var(--surface-100)', color: emp.role === 'admin' ? '#8b5cf6' : 'var(--text-secondary)', fontSize: '0.75rem' }}>
                    {ROLE_OPTIONS.find(r => r.value === emp.role)?.label || emp.role}
                  </span>
                </td>
                <td style={{ padding: '14px 16px' }}>
                  {emp.role === 'admin' ? (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Full Access</span>
                  ) : (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {(emp.permissions || []).length} of {allPerms.length} pages
                    </span>
                  )}
                </td>
                <td style={{ padding: '14px 16px' }}>
                  <span className={`badge ${emp.is_active ? 'badge-completed' : 'badge-rfi'}`} style={{ fontSize: '0.7rem' }}>
                    {emp.is_active ? 'Active' : 'Disabled'}
                  </span>
                </td>
                <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                  <button className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '4px 12px' }} onClick={() => startEdit(emp)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {employees.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            No employees found. Click "New Employee" to create the first account.
          </div>
        )}
      </div>
    </div>
  );
}
