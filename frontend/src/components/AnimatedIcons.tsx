/**
 * AnimatedIcons — Small playful tab icons for the top navigation bar.
 * Each icon is an inline SVG with CSS keyframe animations.
 * Designed to be ~36px, professional yet charming, matching the JEMS teal brand.
 */

/* ────────────────────────────────────────────────────────────
 *  HOME TAB ICON — House with animated heartbeat/ECG trace
 * ──────────────────────────────────────────────────────────── */
export function HomeTabIcon({ size = 36, active = false }: { size?: number; active?: boolean }) {
  const color = active ? '#ffffff' : '#8890a4';

  return (
    <div className={`tab-icon-wrap ${active ? 'active' : ''}`}>
      <svg width={size} height={size} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Roof fill */}
        <path d="M18 6L5 18H31L18 6Z" fill={color} opacity={0.1} />
        {/* Roof outline */}
        <path
          d="M7 18L18 7.5L29 18"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* House body */}
        <rect x="10" y="18" width="16" height="12" rx="1.5" fill={color} opacity={0.08} />
        <rect
          x="10" y="18" width="16" height="12" rx="1.5"
          stroke={color} strokeWidth="1.5" fill="none"
        />
        {/* Door */}
        <rect x="15.5" y="23" width="5" height="7" rx="1" fill={color} opacity={0.2} />
        <circle cx="19" cy="26.5" r="0.6" fill={color} opacity={0.5} />
        {/* Window left */}
        <rect x="11.5" y="20" width="3.5" height="3" rx="0.5" fill={color} opacity={0.15} />
        {/* Window right */}
        <rect x="21" y="20" width="3.5" height="3" rx="0.5" fill={color} opacity={0.15} />
        {/* Heartbeat/ECG trace — animated via CSS */}
        <polyline
          className="home-heartbeat"
          points="4,25 10,25 12.5,21 14.5,29 17,23 19,25 22,25 24,21 26,25 32,25"
          stroke={active ? '#ffffff' : '#b2dfdb'}
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray="60"
          strokeDashoffset="0"
        />
        {/* Chimney */}
        <rect x="23" y="9" width="3" height="7" rx="0.75" fill={color} opacity={0.15} />
        {/* Smoke puffs — animated */}
        <circle className="chimney-smoke chimney-smoke-1" cx="24.5" cy="7" r="1.2" fill={color} opacity={0.12} />
        <circle className="chimney-smoke chimney-smoke-2" cx="25.5" cy="5" r="0.9" fill={color} opacity={0.08} />
      </svg>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
 *  AMBULANCE TAB ICON — Side-view ambulance with spinning
 *  wheels and blinking siren light
 * ──────────────────────────────────────────────────────────── */
export function AmbulanceTabIcon({ size = 36, active = false }: { size?: number; active?: boolean }) {
  const color = active ? '#ffffff' : '#8890a4';
  const sirenColor = active ? '#F57C00' : '#c5cad8';

  return (
    <div className={`tab-icon-wrap ${active ? 'active' : ''}`}>
      <svg width={size} height={size} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Body — rear section */}
        <rect x="3" y="13" width="20" height="13" rx="2" fill={color} opacity={0.1} />
        <rect x="3" y="13" width="20" height="13" rx="2" stroke={color} strokeWidth="1.4" fill="none" />

        {/* Cabin — front section */}
        <path
          d="M23 17H28C29.5 17 31 18 31.5 19.5L33 23V26H23V17Z"
          fill={color} opacity={0.08}
        />
        <path
          d="M23 17H28C29.5 17 31 18 31.5 19.5L33 23V26H23V17Z"
          stroke={color} strokeWidth="1.4" fill="none"
          strokeLinejoin="round"
        />

        {/* Windshield */}
        <path
          d="M25 18H28C29 18 30 18.8 30.5 20L31.5 22.5H25V18Z"
          fill={color} opacity={0.12}
        />

        {/* Medical cross on body */}
        <rect x="11" y="17" width="6" height="1.8" rx="0.5" fill={color} opacity={0.5} />
        <rect x="13" y="15.5" width="1.8" height="5" rx="0.5" fill={color} opacity={0.5} />

        {/* Siren light — animated blink */}
        <rect className="siren-light" x="10" y="10.5" width="4" height="2.5" rx="1.25" fill={sirenColor} />
        <rect className="siren-glow" x="9" y="10" width="6" height="3.5" rx="1.75" fill={sirenColor} opacity={0.2} />

        {/* Siren base */}
        <rect x="10.5" y="12.5" width="3" height="1" rx="0.3" fill={color} opacity={0.2} />

        {/* Headlight */}
        <rect x="32" y="22" width="1.5" height="2" rx="0.5" fill={active ? '#F57C00' : '#c5cad8'} opacity={0.6} />

        {/* Bumper line */}
        <line x1="3" y1="26" x2="33" y2="26" stroke={color} strokeWidth="1.2" strokeLinecap="round" />

        {/* Rear wheel */}
        <g>
          <circle cx="10" cy="27.5" r="3" fill="var(--surface-200)" stroke={color} strokeWidth="1.3" />
          <circle cx="10" cy="27.5" r="1.2" fill={color} opacity={0.3} />
          {/* Spokes */}
          <line x1="10" y1="25" x2="10" y2="30" stroke={color} strokeWidth="0.5" opacity={0.2} />
          <line x1="7.5" y1="27.5" x2="12.5" y2="27.5" stroke={color} strokeWidth="0.5" opacity={0.2} />
        </g>

        {/* Front wheel */}
        <g>
          <circle cx="28" cy="27.5" r="3" fill="var(--surface-200)" stroke={color} strokeWidth="1.3" />
          <circle cx="28" cy="27.5" r="1.2" fill={color} opacity={0.3} />
          <line x1="28" y1="25" x2="28" y2="30" stroke={color} strokeWidth="0.5" opacity={0.2} />
          <line x1="25.5" y1="27.5" x2="30.5" y2="27.5" stroke={color} strokeWidth="0.5" opacity={0.2} />
        </g>

        {/* Stripe on body */}
        <line x1="3" y1="21.5" x2="23" y2="21.5" stroke={color} strokeWidth="0.8" opacity={0.15} />
      </svg>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
 *  EMPLOYEE TAB ICON — Paramedic profile with stethoscope
 *  and subtle breathing animation
 * ──────────────────────────────────────────────────────────── */
export function EmployeeTabIcon({ size = 36, active = false }: { size?: number; active?: boolean }) {
  const color = active ? '#ffffff' : '#8890a4';

  return (
    <div className={`tab-icon-wrap ${active ? 'active' : ''}`}>
      <svg width={size} height={size} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Head */}
        <circle cx="18" cy="12" r="5.5" fill={color} opacity={0.1} />
        <circle cx="18" cy="12" r="5.5" stroke={color} strokeWidth="1.5" fill="none" />

        {/* Hair/cap hint */}
        <path
          d="M13 10.5C13 8 15 6.5 18 6.5C21 6.5 23 8 23 10.5"
          stroke={color} strokeWidth="1.2" fill={color} opacity={0.12}
          strokeLinecap="round"
        />

        {/* Eyes */}
        <circle cx="16" cy="12" r="0.7" fill={color} opacity={0.4} />
        <circle cx="20" cy="12" r="0.7" fill={color} opacity={0.4} />

        {/* Smile */}
        <path d="M16 14.5C16.5 15.3 17.2 15.7 18 15.7C18.8 15.7 19.5 15.3 20 14.5" stroke={color} strokeWidth="0.8" strokeLinecap="round" fill="none" opacity={0.3} />

        {/* Body/shoulders — breathing animation applied via CSS */}
        <path
          className="employee-body"
          d="M8 32C8 25.5 12 21 18 21C24 21 28 25.5 28 32"
          fill={color} opacity={0.08}
        />
        <path
          className="employee-body"
          d="M8 32C8 25.5 12 21 18 21C24 21 28 25.5 28 32"
          stroke={color} strokeWidth="1.5" fill="none"
          strokeLinecap="round"
        />

        {/* Collar / uniform V */}
        <path d="M15 21.5L18 25L21 21.5" stroke={color} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={0.3} />

        {/* Medical cross badge on chest */}
        <rect x="16.25" y="25" width="3.5" height="3.5" rx="0.75" fill={color} opacity={0.15} stroke={color} strokeWidth="0.6" />
        <line x1="18" y1="25.7" x2="18" y2="27.8" stroke={color} strokeWidth="0.8" opacity={0.4} />
        <line x1="16.95" y1="26.75" x2="19.05" y2="26.75" stroke={color} strokeWidth="0.8" opacity={0.4} />

        {/* Stethoscope */}
        <path
          className="stethoscope"
          d="M14 18.5C14 18.5 12.5 20 12.5 22C12.5 24 14 25.5 14 25.5"
          stroke={color} strokeWidth="1" strokeLinecap="round" fill="none" opacity={0.25}
        />
        <circle cx="13" cy="26" r="1" fill={color} opacity={0.2} />
      </svg>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
 *  LARGE AMBULANCE SVG — Professional, detailed side-view
 *  Used inside ambulance cards (not in tab bar)
 * ──────────────────────────────────────────────────────────── */
export function AmbulanceLargeIcon({ width = 160, inUse = false }: { width?: number; inUse?: boolean }) {
  const bodyColor = inUse ? '#088395' : '#8890a4';
  const accentColor = inUse ? '#F57C00' : '#c5cad8';
  const crossColor = inUse ? '#388E3C' : '#a8afc2';

  return (
    <svg width={width} height={width * 0.6} viewBox="0 0 160 96" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Ground shadow */}
      <ellipse cx="80" cy="88" rx="70" ry="4" fill={bodyColor} opacity={0.06} />

      {/* Body — main rear compartment */}
      <rect x="8" y="28" width="90" height="46" rx="4" fill="white" stroke={bodyColor} strokeWidth="2" />
      <rect x="8" y="28" width="90" height="46" rx="4" fill={bodyColor} opacity={0.04} />

      {/* Body highlight stripe */}
      <rect x="8" y="52" width="90" height="3" fill={bodyColor} opacity={0.08} />

      {/* Cabin — front */}
      <path
        d="M98 38H120C126 38 132 42 134 48L140 60V74H98V38Z"
        fill="white" stroke={bodyColor} strokeWidth="2" strokeLinejoin="round"
      />
      <path
        d="M98 38H120C126 38 132 42 134 48L140 60V74H98V38Z"
        fill={bodyColor} opacity={0.03}
      />

      {/* Windshield */}
      <path
        d="M104 40H118C122 40 126 42.5 128 46L133 57H104V40Z"
        fill={bodyColor} opacity={0.08}
        stroke={bodyColor} strokeWidth="1" strokeLinejoin="round"
      />
      {/* Windshield reflection */}
      <path d="M108 42L106 55" stroke="white" strokeWidth="1.5" opacity={0.3} strokeLinecap="round" />

      {/* Side windows on body */}
      <rect x="14" y="34" width="12" height="10" rx="2" fill={bodyColor} opacity={0.06} stroke={bodyColor} strokeWidth="1" />
      <rect x="30" y="34" width="12" height="10" rx="2" fill={bodyColor} opacity={0.06} stroke={bodyColor} strokeWidth="1" />

      {/* Medical CROSS — prominent */}
      <g>
        <rect x="56" y="36" width="22" height="22" rx="4" fill={crossColor} opacity={0.12} />
        <rect x="63" y="39" width="8" height="16" rx="1.5" fill={crossColor} opacity={0.6} />
        <rect x="59" y="43" width="16" height="8" rx="1.5" fill={crossColor} opacity={0.6} />
      </g>

      {/* Siren light bar */}
      <rect x="30" y="22" width="30" height="6" rx="3" fill={bodyColor} opacity={0.12} stroke={bodyColor} strokeWidth="1" />
      <rect className={inUse ? 'siren-active-left' : ''} x="34" y="23.5" width="8" height="3" rx="1.5" fill={inUse ? '#ef4444' : '#ddd'} opacity={inUse ? 0.8 : 0.4} />
      <rect className={inUse ? 'siren-active-right' : ''} x="48" y="23.5" width="8" height="3" rx="1.5" fill={inUse ? '#3b82f6' : '#ddd'} opacity={inUse ? 0.8 : 0.4} />

      {/* Headlight */}
      <rect x="140" y="58" width="4" height="6" rx="1.5" fill={accentColor} opacity={0.7} />
      {inUse && <rect className="headlight-glow" x="138" y="56" width="8" height="10" rx="3" fill={accentColor} opacity={0.15} />}

      {/* Taillight */}
      <rect x="6" y="58" width="3" height="6" rx="1" fill="#ef4444" opacity={0.4} />

      {/* Bumper */}
      <rect x="6" y="74" width="136" height="3" rx="1.5" fill={bodyColor} opacity={0.12} />

      {/* Door handle */}
      <rect x="46" y="56" width="5" height="1.5" rx="0.75" fill={bodyColor} opacity={0.2} />

      {/* Mirror */}
      <rect x="96" y="44" width="4" height="6" rx="1" fill={bodyColor} opacity={0.15} />

      {/* Rear wheel */}
      <g>
        <circle cx="32" cy="78" r="10" fill="var(--surface-100)" stroke={bodyColor} strokeWidth="2" />
        <circle cx="32" cy="78" r="6" fill="var(--surface-200)" stroke={bodyColor} strokeWidth="1" />
        <circle cx="32" cy="78" r="2.5" fill={bodyColor} opacity={0.3} />
        {/* Wheel spokes */}
        <line x1="32" y1="69" x2="32" y2="87" stroke={bodyColor} strokeWidth="0.7" opacity={0.1} />
        <line x1="23" y1="78" x2="41" y2="78" stroke={bodyColor} strokeWidth="0.7" opacity={0.1} />
        <line x1="25.4" y1="71.4" x2="38.6" y2="84.6" stroke={bodyColor} strokeWidth="0.7" opacity={0.1} />
        <line x1="38.6" y1="71.4" x2="25.4" y2="84.6" stroke={bodyColor} strokeWidth="0.7" opacity={0.1} />
      </g>

      {/* Front wheel */}
      <g>
        <circle cx="120" cy="78" r="10" fill="var(--surface-100)" stroke={bodyColor} strokeWidth="2" />
        <circle cx="120" cy="78" r="6" fill="var(--surface-200)" stroke={bodyColor} strokeWidth="1" />
        <circle cx="120" cy="78" r="2.5" fill={bodyColor} opacity={0.3} />
        <line x1="120" y1="69" x2="120" y2="87" stroke={bodyColor} strokeWidth="0.7" opacity={0.1} />
        <line x1="111" y1="78" x2="129" y2="78" stroke={bodyColor} strokeWidth="0.7" opacity={0.1} />
        <line x1="113.4" y1="71.4" x2="126.6" y2="84.6" stroke={bodyColor} strokeWidth="0.7" opacity={0.1} />
        <line x1="126.6" y1="71.4" x2="113.4" y2="84.6" stroke={bodyColor} strokeWidth="0.7" opacity={0.1} />
      </g>

      {/* "AMBULANCE" text on side (subtle) */}
      <text x="25" y="68" fontSize="5" fontWeight="700" fill={bodyColor} opacity={0.15} letterSpacing="2" fontFamily="var(--font-sans)">
        AMBULANCE
      </text>
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────
 *  LARGE EMPLOYEE SVG — Professional paramedic profile
 *  Used inside employee cards (not in tab bar)
 * ──────────────────────────────────────────────────────────── */
export function EmployeeLargeIcon({
  size = 100,
  initials = '??',
  onShift = false,
  showDot = true,
}: {
  size?: number;
  initials?: string;
  onShift?: boolean;
  showDot?: boolean;
}) {
  const ringColor = onShift ? '#088395' : '#c5cad8';
  const bgColor = onShift ? 'rgba(8, 131, 149, 0.06)' : 'rgba(136, 144, 164, 0.06)';

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Outer ring — animated pulse when on shift */}
        <circle
          className={onShift ? 'employee-ring-pulse' : ''}
          cx="50" cy="50" r="48"
          stroke={ringColor} strokeWidth="2"
          fill="none" opacity={0.3}
        />
        {/* Inner circle background */}
        <circle cx="50" cy="50" r="44" fill={bgColor} />
        <circle cx="50" cy="50" r="44" stroke={ringColor} strokeWidth="1.5" fill="none" opacity={0.2} />

        {/* Head */}
        <circle cx="50" cy="36" r="14" fill={ringColor} opacity={0.1} />
        <circle cx="50" cy="36" r="14" stroke={ringColor} strokeWidth="1.5" fill="none" opacity={0.3} />

        {/* Body/Shoulders */}
        <path
          d="M24 82C24 68 35 58 50 58C65 58 76 68 76 82"
          fill={ringColor} opacity={0.08}
        />
        <path
          d="M24 82C24 68 35 58 50 58C65 58 76 68 76 82"
          stroke={ringColor} strokeWidth="1.5" fill="none" opacity={0.25}
          strokeLinecap="round"
        />

        {/* Uniform V-neck collar */}
        <path d="M42 59L50 68L58 59" stroke={ringColor} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={0.2} />

        {/* Medical cross on chest */}
        <rect x="46" y="70" width="8" height="8" rx="1.5" fill={ringColor} opacity={0.1} />
        <rect x="46" y="70" width="8" height="8" rx="1.5" fill="none" stroke={ringColor} strokeWidth="0.8" opacity={0.2} />
        <line x1="50" y1="71.5" x2="50" y2="76.5" stroke={ringColor} strokeWidth="1" opacity={0.25} />
        <line x1="47.5" y1="74" x2="52.5" y2="74" stroke={ringColor} strokeWidth="1" opacity={0.25} />

        {/* Initials text */}
        <text
          x="50" y="40"
          textAnchor="middle"
          fontSize="13"
          fontWeight="700"
          fill={ringColor}
          opacity={0.5}
          fontFamily="var(--font-sans)"
        >
          {initials}
        </text>
      </svg>

      {/* On-shift status dot — top right corner */}
      {showDot && onShift && (
        <div className="shift-status-dot shift-status-online" />
      )}
      {showDot && !onShift && (
        <div className="shift-status-dot shift-status-offline" />
      )}
    </div>
  );
}
