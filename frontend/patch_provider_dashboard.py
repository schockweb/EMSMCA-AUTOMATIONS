import re

with open('/Users/mariamahon/Desktop/EMS AUTOMATION/EMSMCA-AUTOMATIONS/frontend/src/pages/crew/ProviderAdminDashboard.tsx', 'r') as f:
    content = f.read()

# 1. Add imports
import_statement = """import { HomeTabIcon, AmbulanceTabIcon, EmployeeTabIcon, AmbulanceLargeIcon, EmployeeLargeIcon } from '../../components/AnimatedIcons';
import '../../index.css';
"""
content = re.sub(r"(import { HPCSA_CATEGORIES, CATEGORY_META, type HpcsaCategory } from '../../data/hpcsaScope';)", r"\1\n" + import_statement, content)

# 2. Add 'dashboard' to Tab type
content = re.sub(r"type Tab = 'employees' \| 'vehicles';", r"type Tab = 'dashboard' | 'employees' | 'vehicles';", content)

# 3. Change initial activeTab state
content = re.sub(r"const \[activeTab, setActiveTab\] = useState<Tab>\('employees'\);", r"const [activeTab, setActiveTab] = useState<Tab>('dashboard');", content)

# 4. Remove sidebar and add top tab bar
sidebar_pattern = r"\{/\* Sidebar / top tabs \*/\}.*?\{/\* Main \*/\}"
new_nav = """{/* Center: Animated tab icons */}
        <div className="tab-bar" style={{ display: 'flex', justifyContent: 'center', background: '#fff', borderBottom: `1px solid ${LN}` }}>
          <button
            className={`tab-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <HomeTabIcon size={36} active={activeTab === 'dashboard'} />
            <span>Dashboard</span>
          </button>
          <button
            className={`tab-item ${activeTab === 'vehicles' ? 'active' : ''}`}
            onClick={() => setActiveTab('vehicles')}
          >
            <AmbulanceTabIcon size={36} active={activeTab === 'vehicles'} />
            <span>Ambulances</span>
          </button>
          <button
            className={`tab-item ${activeTab === 'employees' ? 'active' : ''}`}
            onClick={() => setActiveTab('employees')}
          >
            <EmployeeTabIcon size={36} active={activeTab === 'employees'} />
            <span>Employees</span>
          </button>
        </div>
        
        {/* Main */}"""
content = re.sub(sidebar_pattern, new_nav, content, flags=re.DOTALL)

# 5. Fix body flex direction to always be column now that sidebar is gone
content = re.sub(r"flexDirection: isMobile \? 'column' : 'row',", r"flexDirection: 'column',", content)

# 6. Replace main content rendering with the new Dashboard, Ambulances, and Employees views.
# We will find the `<main>` tag and replace its contents.
main_pattern = r"<main.*?>(.*?)</main>"

new_main_content = """
          {activeTab === 'dashboard' && (
            <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto', width: '100%' }}>
              <h1 style={{ fontSize: '1.8rem', fontWeight: 800, marginBottom: '24px' }}>Dashboard Overview</h1>
              
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px', marginBottom: '32px' }}>
                <div style={{ background: '#fff', borderRadius: '8px', padding: '24px', border: `1px solid ${LN}`, boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}>
                  <h3 style={{ margin: '0 0 16px 0', color: MUT, fontSize: '0.9rem', textTransform: 'uppercase' }}>Fleet Snapshot</h3>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <div style={{ fontSize: '2.5rem', fontWeight: 800, color: G }}>{vehicles.length}</div>
                    <div>
                      <div style={{ fontWeight: 600 }}>Total Vehicles</div>
                      <div style={{ fontSize: '0.8rem', color: MUT }}>{vehicles.filter(v => v.in_use).length} in use</div>
                    </div>
                  </div>
                </div>

                <div style={{ background: '#fff', borderRadius: '8px', padding: '24px', border: `1px solid ${LN}`, boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}>
                  <h3 style={{ margin: '0 0 16px 0', color: MUT, fontSize: '0.9rem', textTransform: 'uppercase' }}>Crew Snapshot</h3>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <div style={{ fontSize: '2.5rem', fontWeight: 800, color: '#0ea5e9' }}>{employees.length}</div>
                    <div>
                      <div style={{ fontWeight: 600 }}>Total Crew Members</div>
                      <div style={{ fontSize: '0.8rem', color: MUT }}>Available for shifts</div>
                    </div>
                  </div>
                </div>
              </div>

              <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '16px' }}>Quick Navigation</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
                {['Cases', 'ERA Tracking', 'Analytics', 'Providers', 'Rate Schemas', 'Failed Forms', 'System Health'].map(item => (
                  <div key={item} style={{ background: '#fff', padding: '16px', borderRadius: '6px', border: `1px solid ${LN}`, fontWeight: 600, color: INK, cursor: 'pointer', textAlign: 'center' }}>
                    {item}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'vehicles' && (
            <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto', width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <h1 style={{ fontSize: '1.8rem', fontWeight: 800, margin: 0 }}>Fleet Management 🚑</h1>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn onClick={fetchVehicles}>Refresh</Btn>
                  <Btn kind="primary" onClick={() => setAddVehOpen(true)}>+ New Vehicle</Btn>
                </div>
              </div>

              {loading ? (
                <div style={{ padding: 40, textAlign: 'center', color: MUT }}>Loading...</div>
              ) : vehicles.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: MUT, background: '#fff', borderRadius: 8, border: `1px solid ${LN}` }}>
                  No vehicles registered.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '24px' }}>
                  {vehicles.map(v => (
                    <div key={v.id} style={{ background: '#fff', borderRadius: '12px', border: `1px solid ${LN}`, overflow: 'hidden', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)', position: 'relative' }}>
                      <div style={{ position: 'absolute', top: 12, right: 12, padding: '4px 10px', borderRadius: '12px', background: v.in_use ? '#dcfce7' : '#f3f4f6', color: v.in_use ? '#166534' : '#4b5563', fontSize: '0.7rem', fontWeight: 700 }}>
                        {v.in_use ? 'IN USE' : 'AVAILABLE'}
                      </div>
                      <div style={{ padding: '24px', textAlign: 'center', borderBottom: `1px solid ${LN}` }}>
                        <AmbulanceLargeIcon width={160} inUse={v.in_use || false} />
                        <h3 style={{ margin: '12px 0 4px 0', fontSize: '1.4rem', fontWeight: 800 }}>{v.callsign}</h3>
                        <div style={{ display: 'inline-block', background: '#fef3c7', border: '1px solid #d97706', color: '#92400e', padding: '4px 12px', borderRadius: '4px', fontFamily: 'monospace', fontWeight: 700, fontSize: '0.9rem' }}>
                          {v.registration}
                        </div>
                      </div>
                      <div style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f9fafb' }}>
                        <div style={{ fontSize: '0.8rem', color: MUT, fontWeight: 600 }}>{v.vehicle_type}</div>
                        <Btn kind="danger" onClick={() => deleteVehicle(v.id, v.callsign)}>Delete</Btn>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'employees' && (
            <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto', width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <h1 style={{ fontSize: '1.8rem', fontWeight: 800, margin: 0 }}>Crew Members 👤</h1>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn onClick={fetchEmployees}>Refresh</Btn>
                  <Btn kind="primary" onClick={() => setAddEmpOpen(true)}>+ New Employee</Btn>
                </div>
              </div>

              {loading ? (
                <div style={{ padding: 40, textAlign: 'center', color: MUT }}>Loading...</div>
              ) : employees.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: MUT, background: '#fff', borderRadius: 8, border: `1px solid ${LN}` }}>
                  No crew members registered.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '24px' }}>
                  {employees.map(e => {
                    const meta = CATEGORY_META[e.qualification as HpcsaCategory] || { label: e.qualification, tier: 'BLS' };
                    return (
                      <div key={e.id} style={{ background: '#fff', borderRadius: '12px', border: `1px solid ${LN}`, overflow: 'hidden', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px' }}>
                        <div style={{ marginBottom: '16px' }}>
                          <EmployeeLargeIcon size={90} initials={e.initials || e.full_name[:2].upper()} onShift={e.is_active} />
                        </div>
                        <h3 style={{ margin: '0 0 4px 0', fontSize: '1.2rem', fontWeight: 800 }}>{e.full_name}</h3>
                        <div style={{ fontSize: '0.8rem', color: MUT, marginBottom: '12px' }}>{e.hpcsa_number || 'No HPCSA'}</div>
                        <div style={{ display: 'inline-block', padding: '4px 12px', borderRadius: '12px', background: `${qualColour(e.qualification)}15`, color: qualColour(e.qualification), fontSize: '0.75rem', fontWeight: 700, marginBottom: '16px' }}>
                          {e.qualification} - {meta.label}
                        </div>
                        <div style={{ display: 'flex', gap: 8, width: '100%', marginTop: 'auto' }}>
                          <Btn onClick={() => openEditEmp(e)} style={{ flex: 1 }}>Edit</Btn>
                          <Btn kind="danger" onClick={() => deleteEmployee(e.id, e.full_name)} style={{ flex: 1 }}>Delete</Btn>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
"""

# Now replace everything inside `<main>`
new_main_tag = f"""<main style={{{{ flex: 1, overflowY: 'auto', background: BG, padding: 0 }}}}>{new_main_content}</main>"""

content = re.sub(main_pattern, new_main_tag, content, flags=re.DOTALL)

with open('/Users/mariamahon/Desktop/EMS AUTOMATION/EMSMCA-AUTOMATIONS/frontend/src/pages/crew/ProviderAdminDashboard.tsx', 'w') as f:
    f.write(content)

print("Modifications written successfully.")
