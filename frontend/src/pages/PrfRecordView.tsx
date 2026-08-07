/**
 * PrfRecordView — the PRF as plain data, not as a form.
 *
 * WHY THIS EXISTS
 * ---------------
 * The PDF view is a pixel-exact A4 reproduction: fixed 1220px sheets, three
 * stacked grids, a hard ~944px height ceiling per page, and an exporter that
 * slices anything taller. That is the right thing for a document a scheme
 * receives — and it is inherently fragile. Every layout defect this file exists
 * to survive had the same shape: a block grew, the sheet went over the ceiling,
 * and captured information ended up cut off, overlapped or pushed somewhere
 * nobody looked.
 *
 * We cannot guarantee that never happens. So this view guarantees the other
 * thing: that the information is always READABLE, whatever the layout does.
 *
 * THE ONE RULE THAT MAKES IT WORK
 * -------------------------------
 * It enumerates the DATA, not a list of fields. Every key on form_data is
 * rendered — the ones this file knows about land in a named section, and
 * anything it does not recognise falls through to "Other captured fields".
 * A curated list would reproduce exactly the failure it is meant to protect
 * against: a field captured by the crew that no one can see, because the view
 * was never told about it. Nothing here can be silently omitted.
 *
 * It also shares no layout machinery with the sheets: no fixed widths, no
 * grids that can overflow, no height ceiling. It is a flat, collapsible list
 * that reflows to any screen.
 */
import { useMemo, useState } from 'react';

const INK = '#0b1020';
const MUT = '#5b6478';
const LN = '#088395';
const SOFT = '#f8fafc';
const BORDER = '#e2e8f0';

const isDataUrl = (v: unknown): v is string =>
  typeof v === 'string' && /^data:image\//i.test(v);

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** snake_case / camelCase → "Title Case". */
const humanise = (key: string): string =>
  key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bId\b/g, 'ID')
    .replace(/\bHpcsa\b/g, 'HPCSA')
    .replace(/\bIv\b/g, 'IV')
    .replace(/\bPrf\b/g, 'PRF')
    .replace(/\bKm\b/g, 'KM')
    .replace(/\bDob\b/g, 'DOB')
    .replace(/\bGcs\b/g, 'GCS')
    .replace(/\bBp\b/g, 'BP')
    .replace(/\bRht\b/g, 'RHT')
    .replace(/\bWca\b/g, 'WCA')
    .replace(/\bRaf\b/g, 'RAF')
    .replace(/\bAod\b/g, 'AOD')
    .replace(/\bPvt\b/g, 'Private');

// Ordered groups. `match` claims a key for a section; the FIRST match wins, and
// anything unclaimed lands in the catch-all at the end.
const GROUPS: Array<{ title: string; match: (k: string) => boolean }> = [
  { title: 'Call & Dispatch', match: k => /^(call_type|transfer_subtype|incident_|suburb_ward|priority|dispatch|pre_planned|responding|callout_|preauth)/.test(k) },
  { title: 'Patient', match: k => /^(patient_|gender|age|accompanying|mechanism|next_of_kin|nok_)/.test(k) },
  { title: 'Debtor', match: k => /^debtor_/.test(k) },
  { title: 'Billing & Medical Aid', match: k => /^(billing_|medical_aid|medical_scheme|scheme_|main_member|dependent|dependant|pvt_|med_aid_(?!dec_death)|post_auth|invoice)/.test(k) },
  { title: 'Clinical', match: k => /^(chief_complaint|primary_diagnosis|findings|allergies|current_medications|past_|events_hpi|history|assessment_|monitoring_|vitals_|primary_survey|secondary_|airway|breathing|circulation|oxygen|bvm|device|immobilis|collar|spinal|splint|burn|body_marks|gcs|pupil|ecg|glucose|resus|cpr|defib|shock|intubat|supraglottic|iv_|infusion|catheter|drain)/.test(k) },
  { title: 'Handover', match: k => /^(handover_|receiving_|ward|condition|destination|dest_)/.test(k) },
  { title: 'Refusal / Declaration of Death', match: k => /^(rht_|refus|med_aid_dec_death|declaration|death_|deceased)/.test(k) },
  { title: 'Return Trip', match: k => /^return_/.test(k) },
  { title: 'Crew & Vehicle', match: k => /^(crew_|treating_|overseen_|vehicle_|callsign|registration)/.test(k) },
  { title: 'Valuables & Notes', match: k => /^(valuables|handed_to|motivation|management_notes|notes|comment)/.test(k) },
  { title: 'Signatures & Documents', match: k => /(signature|sticker|_image$|_document|_pdf$|nursing_notes|attachment|photo)/.test(k) },
];

function Value({ value }: { value: unknown }) {
  if (isDataUrl(value)) {
    return (
      <img src={value} alt="captured"
        style={{ maxWidth: 260, maxHeight: 150, objectFit: 'contain', border: `1px solid ${BORDER}`, borderRadius: 6, background: '#fff', display: 'block' }} />
    );
  }
  if (typeof value === 'boolean') {
    return <span style={{ fontWeight: 700, color: value ? LN : MUT }}>{value ? 'Yes' : 'No'}</span>;
  }
  if (Array.isArray(value)) {
    // Array of records (vitals sets, IV lines, medications) → a real table, so
    // each row stays readable however many were captured.
    if (value.some(v => v && typeof v === 'object' && !Array.isArray(v))) {
      const cols = Array.from(new Set(value.flatMap(v => (v && typeof v === 'object') ? Object.keys(v) : [])));
      return (
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '0.82rem', minWidth: 320 }}>
            <thead>
              <tr>
                <th style={{ padding: '5px 8px', textAlign: 'left', background: SOFT, border: `1px solid ${BORDER}`, fontSize: '0.68rem', textTransform: 'uppercase', color: MUT }}>#</th>
                {cols.map(c => (
                  <th key={c} style={{ padding: '5px 8px', textAlign: 'left', background: SOFT, border: `1px solid ${BORDER}`, fontSize: '0.68rem', textTransform: 'uppercase', color: MUT, whiteSpace: 'nowrap' }}>{humanise(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.map((row, i) => (
                <tr key={i}>
                  <td style={{ padding: '5px 8px', border: `1px solid ${BORDER}`, color: MUT }}>{i + 1}</td>
                  {cols.map(c => {
                    const cell = (row && typeof row === 'object') ? (row as Record<string, unknown>)[c] : undefined;
                    return (
                      <td key={c} style={{ padding: '5px 8px', border: `1px solid ${BORDER}`, verticalAlign: 'top' }}>
                        {isBlank(cell) ? <span style={{ color: '#cbd5e1' }}>—</span> : <Value value={cell} />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return <span>{value.map(v => String(v)).join(', ')}</span>;
  }
  if (value && typeof value === 'object') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k} style={{ fontSize: '0.82rem' }}>
            <span style={{ color: MUT }}>{humanise(k)}: </span>
            {isBlank(v) ? <span style={{ color: '#cbd5e1' }}>—</span> : <Value value={v} />}
          </div>
        ))}
      </div>
    );
  }
  return <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{String(value)}</span>;
}

function Section({ title, entries, defaultOpen }: {
  title: string;
  entries: Array<[string, unknown]>;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (entries.length === 0) return null;
  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, marginBottom: 12, background: '#fff', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 10, padding: '12px 14px', cursor: 'pointer', border: 'none',
          background: open ? 'rgba(8,131,149,0.06)' : '#fff', textAlign: 'left',
        }}
      >
        <span style={{ fontWeight: 800, fontSize: '0.92rem', color: INK }}>{title}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: MUT, background: SOFT, border: `1px solid ${BORDER}`, borderRadius: 999, padding: '2px 9px' }}>
            {entries.length}
          </span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={MUT} strokeWidth="2.5"
               strokeLinecap="round" strokeLinejoin="round"
               style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${BORDER}` }}>
          {entries.map(([k, v], i) => (
            <div key={k} style={{
              display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'baseline',
              padding: '9px 14px',
              borderTop: i === 0 ? 'none' : `1px solid ${SOFT}`,
            }}>
              <div style={{
                flex: '0 0 220px', minWidth: 160, fontSize: '0.74rem', fontWeight: 700,
                color: MUT, textTransform: 'uppercase', letterSpacing: '0.04em',
              }}>
                {humanise(k)}
              </div>
              <div style={{ flex: '1 1 240px', minWidth: 0, fontSize: '0.88rem', color: INK }}>
                <Value value={v} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PrfRecordView({ prf }: { prf: any }) {
  const [showEmpty, setShowEmpty] = useState(false);

  const { sections, capturedCount, totalCount } = useMemo(() => {
    const fd: Record<string, unknown> = prf?.form_data || {};
    const meta: Array<[string, unknown]> = [
      ['prf_number', prf?.prf_number],
      ['case_number', prf?.case_number],
      ['status', prf?.status],
      ['submitted_at', prf?.submitted_at],
      ['updated_at', prf?.updated_at],
      ['provider', prf?.provider],
      ['vehicle', prf?.vehicle],
      ['crew_1', prf?.crew_1],
      ['crew_2', prf?.crew_2],
    ];
    const timesAndKm: Array<[string, unknown]> = [
      ...Object.entries(prf?.timestamps || {}),
      ...Object.entries(prf?.kms || {}),
    ];
    const topLevelSignatures: Array<[string, unknown]> = Object.entries(prf?.signatures || {});

    const keep = (e: Array<[string, unknown]>) => showEmpty ? e : e.filter(([, v]) => !isBlank(v));

    // Claim each form_data key for the FIRST group that matches it; whatever is
    // left over is still rendered, under "Other captured fields". That is the
    // guarantee: no key can be dropped by omission from this file.
    const claimed = new Set<string>();
    const grouped = GROUPS.map(g => {
      const entries = Object.entries(fd).filter(([k]) => {
        if (claimed.has(k)) return false;
        if (!g.match(k)) return false;
        claimed.add(k);
        return true;
      });
      return { title: g.title, entries: keep(entries) };
    });
    const leftovers = Object.entries(fd).filter(([k]) => !claimed.has(k));

    const all = [
      { title: 'Record', entries: keep(meta) },
      { title: 'Times & Odometer', entries: keep(timesAndKm) },
      ...grouped,
      ...(topLevelSignatures.length ? [{ title: 'Signatures (record)', entries: keep(topLevelSignatures) }] : []),
      { title: 'Other captured fields', entries: keep(leftovers) },
    ];

    const everything = [
      ...meta, ...timesAndKm, ...topLevelSignatures, ...Object.entries(fd),
    ];
    return {
      sections: all,
      capturedCount: everything.filter(([, v]) => !isBlank(v)).length,
      totalCount: everything.length,
    };
  }, [prf, showEmpty]);

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 12px 40px', fontFamily: 'var(--font-sans, "Segoe UI", system-ui, sans-serif)' }}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center',
        justifyContent: 'space-between', marginBottom: 14,
        padding: '12px 14px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
      }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: '1rem', color: INK }}>Full Record</div>
          <div style={{ fontSize: '0.78rem', color: MUT, marginTop: 2 }}>
            Every field captured on this PRF, independent of the printed layout.
            Showing <strong style={{ color: INK }}>{capturedCount}</strong> captured of {totalCount}.
          </div>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: MUT, cursor: 'pointer' }}>
          <input type="checkbox" checked={showEmpty} onChange={e => setShowEmpty(e.target.checked)} style={{ width: 16, height: 16, accentColor: LN, cursor: 'pointer' }} />
          Show empty fields
        </label>
      </div>

      {sections.map((s, i) => (
        <Section key={s.title} title={s.title} entries={s.entries} defaultOpen={i < 3} />
      ))}
    </div>
  );
}
