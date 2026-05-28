/**
 * App — Root component with routing and layout.
 */
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
// OCR intake parked — Upload, AdminQueue (Verification), and DocumentReview
// pages are kept on disk but no longer routed. Re-import + re-add the routes
// below to bring the paper-PRF pipeline back online.
// import Upload from './pages/Upload';
// import AdminQueue from './pages/AdminQueue';
// import DocumentReview from './pages/DocumentReview';
import Adjudication from './pages/Adjudication';

import AnalyticsDashboard from './pages/Analytics';
import Cases from './pages/Cases';
import PRFView from './pages/PRFView';
import ERATracking from './pages/ERATracking';
import EmployeeManagement from './pages/EmployeeManagement';
import SystemHealth from './pages/SystemHealth';
import Logo from './components/Logo';
import ErrorBoundary from './components/ErrorBoundary';
import ProviderManagement from './pages/ProviderManagement';
import RateSchemas from './pages/RateSchemas';
import TariffBilling from './pages/TariffBilling';
import FailedForms from './pages/FailedForms';
import CrewDashboard from './pages/crew/CrewDashboard';
import DigitalPRFForm from './pages/crew/DigitalPRFForm';
import ProviderLogin from './pages/crew/ProviderLogin';
import ProviderAdminDashboard from './pages/crew/ProviderAdminDashboard';
import './index.css';

// Legacy `/${slug}/crew/login` URL — bounces to the unified provider login
// at `/${slug}/login`. The old CrewLogin page was removed.
function CrewLoginRedirect() {
  const { providerSlug } = useParams<{ providerSlug: string }>();
  return <Navigate to={`/${providerSlug}/login`} replace />;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-overlay">
        <div className="spinner" style={{ width: 40, height: 40 }} />
      </div>
    );
  }

  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const userPerms = user?.permissions || [];

  const navItems = [
    { path: '/', label: 'Dashboard', perm: 'dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
    // OCR Verification nav parked — restore once paper-PRF intake comes back:
    // { path: '/verify', label: 'Verification', perm: 'admin_queue', icon: '...' },
    { path: '/cases', label: 'Case Management', perm: 'cases', icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },
    
    { path: '/era-tracking', label: 'ERA Tracking', perm: 'era_tracking', icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
    { path: '/analytics', label: 'Analytics', perm: 'analytics', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
    { path: '/providers', label: 'Providers', perm: 'providers', icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4' },
    { path: '/add-schemas', label: 'Med. Schemes', perm: 'providers', icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4' },
    { path: '/tariff-billing', label: 'Tariff Billing', perm: 'tariff_billing', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01' },
    { path: '/employees', label: 'Employees', perm: 'employees', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z' },
    ...(isAdmin ? [
      { path: '/failed-forms', label: '⚠️ Failed Forms', perm: 'failed_forms', icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z' },
      { path: '/system-health', label: 'System Health', perm: 'system_health', icon: 'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z' },
    ] : []),
  ];

  const visibleNav = navItems.filter(item => isAdmin || userPerms.includes(item.perm));

  const initials = user?.full_name
    ?.split(' ')
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'AD';

  const isReviewPage = location.pathname.includes('/review/');

  return (
    <div className={`app-layout ${isReviewPage ? 'is-review-mode' : ''}`}>
      {/* Top Navbar */}
      {!isReviewPage && (
        <nav className="navbar">
          <div className="navbar-inner">
            <div className="navbar-logo">
              <Logo size={32} />
            </div>

            <div className="navbar-nav">
              {visibleNav.map((item) => (
                <button
                  key={item.path}
                  className={`nav-item ${location.pathname === item.path ? 'active' : ''}`}
                  onClick={() => navigate(item.path)}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={item.icon} />
                  </svg>
                  {item.label}
                </button>
              ))}
            </div>

            <div className="navbar-user">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ textAlign: 'right', display: 'none' }}>
                   {/* Desktop Only Labels */}
                </div>
                <div className="nav-avatar" style={{ background: 'var(--surface-100)', color: 'var(--brand-teal)', border: '1px solid var(--glass-border)' }}>
                  {initials}
                </div>
                <button
                  onClick={logout}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 8, borderRadius: 'var(--radius-sm)' }}
                  className="btn-secondary"
                  title="Sign Out"
                  id="btn-logout"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </nav>
      )}

      {/* Main content */}
      <main className="main-content">
        <div className={isReviewPage ? 'container-fluid' : 'container'}>
          {children}
        </div>
      </main>
    </div>
  );
}

function LayoutRoute({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <AppLayout>{children}</AppLayout>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<LayoutRoute><Dashboard /></LayoutRoute>} />
          {/* OCR intake parked — uncomment to bring back paper-PRF pipeline:
          <Route path="/upload" element={<LayoutRoute><Upload /></LayoutRoute>} />
          <Route path="/verify" element={<LayoutRoute><AdminQueue /></LayoutRoute>} />
          <Route path="/review/:id" element={<LayoutRoute><DocumentReview /></LayoutRoute>} />
          */}
          <Route path="/adjudication" element={<LayoutRoute><Adjudication /></LayoutRoute>} />
    
          <Route path="/era-tracking" element={<LayoutRoute><ERATracking /></LayoutRoute>} />
          <Route path="/analytics" element={<LayoutRoute><AnalyticsDashboard /></LayoutRoute>} />
          <Route path="/cases" element={<LayoutRoute><Cases /></LayoutRoute>} />
          <Route path="/cases/:caseId/prf" element={<LayoutRoute><PRFView /></LayoutRoute>} />
          <Route path="/employees" element={<LayoutRoute><EmployeeManagement /></LayoutRoute>} />
          <Route path="/providers" element={<LayoutRoute><ProviderManagement /></LayoutRoute>} />
          <Route path="/add-schemas" element={<LayoutRoute><RateSchemas /></LayoutRoute>} />
          <Route path="/tariff-billing" element={<LayoutRoute><TariffBilling /></LayoutRoute>} />
          <Route path="/failed-forms" element={<LayoutRoute><FailedForms /></LayoutRoute>} />
          <Route path="/system-health" element={<LayoutRoute><SystemHealth /></LayoutRoute>} />

          {/* ── Crew Portal Routes (separate auth, no admin layout) ── */}
          <Route path="/:providerSlug/login" element={<ProviderLogin />} />
          <Route path="/:providerSlug/admin/dashboard" element={<ProviderAdminDashboard />} />
          {/* Legacy crew-login URL — redirect to the unified provider login.
              The CrewLogin page was removed; this keeps old bookmarks working. */}
          <Route path="/:providerSlug/crew/login" element={<CrewLoginRedirect />} />
          {/* Crew PDF view — same PRFView component but outside the admin
              ProtectedRoute so the crew session is honoured. Backend
              admin/by-case endpoint already accepts crew JWTs for the
              crew member who created the PRF. Path uses /prf-view/ so it
              doesn't collide with the editable /prf/:prfId route below. */}
          <Route path="/:providerSlug/crew/prf-view/:caseId" element={<PRFView />} />
          <Route path="/:providerSlug/crew/dashboard" element={<CrewDashboard />} />
          <Route path="/:providerSlug/crew/prf/:prfId" element={<DigitalPRFForm />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
    </ErrorBoundary>
  );
}
