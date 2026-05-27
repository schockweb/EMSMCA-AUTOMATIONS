/**
 * EMS Logo Component — Uses the original brand logo image.
 */
export default function Logo({ size = 32, showText = true, layout = 'horizontal', textColor = 'var(--text-primary)' }: { 
  size?: number; 
  showText?: boolean;
  layout?: 'horizontal' | 'vertical';
  textColor?: string;
}) {
  const logoImg = (
    <img 
      src="/ems-logo.png" 
      alt="EMS Medical Claims Administrators" 
      width={size} 
      height={size} 
      style={{ objectFit: 'contain', flexShrink: 0 }} 
    />
  );

  if (!showText) return logoImg;

  if (layout === 'vertical') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <img 
          src="/ems-logo.png" 
          alt="EMS Medical Claims Administrators" 
          width={size * 2.5} 
          height={size * 2.5} 
          style={{ objectFit: 'contain' }} 
        />
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2.5rem', fontWeight: 900, color: '#2D3436', letterSpacing: '-0.05em', lineHeight: 1 }}>EMS</div>
          <div style={{ 
            fontSize: '0.75rem', 
            textTransform: 'uppercase', 
            color: 'var(--text-muted)', 
            letterSpacing: '0.25em', 
            marginTop: 12,
            fontWeight: 600,
            opacity: 0.8
          }}>
            Medical Claims Administrators
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {logoImg}
      <div style={{ lineHeight: 1.1 }}>
        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: textColor, letterSpacing: '-0.02em' }}>EMS</div>
        <div style={{ fontSize: '0.6rem', textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.1em', marginTop: 2, fontWeight: 500 }}>
          Medical Claims Administrators
        </div>
      </div>
    </div>
  );
}
