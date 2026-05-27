/**
 * Admin Queue — Enterprise Insurance Clearinghouse Layout
 * Features: KPI ribbon, sortable columns, batch select, focus mode,
 * drag-and-drop bundling, confidence gauges, smart status badges.
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

interface DocumentItem {
  id: string;
  original_filename: string;
  document_type: string;
  ocr_status: string;
  ocr_confidence_avg: number | null;
  needs_hitl_review: boolean;
  extracted_data: Record<string, any> | null;
  ocr_field_scores: Record<string, number> | null;
  created_at: string;
  group_id: string | null;
  is_group_primary: boolean;
}

// Core fields the backend always checks — these being empty triggers the HITL flag
const CORE_HITL_FIELDS = ['patient_name', 'medical_scheme', 'incident_date', 'treating_provider', 'prf_number'];

/**
 * Derive which fields should be highlighted red in DocumentReview.
 * Priority: use ocr_field_scores from backend (score = 0 = missing), else
 * fall back to checking if key core fields are null/empty in extracted_data.
 */
const getFlaggedFields = (doc: DocumentItem): string[] => {
  if (doc.ocr_field_scores) {
    return Object.entries(doc.ocr_field_scores)
      .filter(([, score]) => score === 0)
      .map(([key]) => key);
  }
  if (!doc.extracted_data) return CORE_HITL_FIELDS;
  return CORE_HITL_FIELDS.filter(k => !doc.extracted_data![k]);
};

// ── Editable Type Badge ──────────────────────────────────────────────────────
const EditableDocumentType = ({ doc, onUpdate }: { doc: DocumentItem; onUpdate: (id: string, t: string) => void }) => {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(doc.document_type || 'PRF');
  const save = async () => {
    const t = val.trim() || 'Other';
    if (t !== doc.document_type) {
      const fd = new FormData(); fd.append('document_type', t);
      await api.patch(`/api/documents/${doc.id}/type`, fd).catch(() => {});
      onUpdate(doc.id, t);
    }
    setEditing(false);
  };
  if (editing) return (
    <input autoFocus value={val} onChange={e => setVal(e.target.value)}
      onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
      style={{ width: 80, padding: '3px 8px', borderRadius: 6, border: '1.5px solid var(--brand-teal)', fontSize: '0.75rem', outline: 'none', background: 'white' }} />
  );
  const colors: Record<string, string> = { PRF: 'var(--brand-teal)', GHF: '#7c3aed', TRACKER: '#0891b2', Other: '#6b7280' };
  const bg = (colors[val] || colors.Other);
  return (
    <span onClick={() => setEditing(true)} title="Click to edit"
      style={{ cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, padding: '3px 10px', borderRadius: 99, color: 'white', background: bg, letterSpacing: '0.04em', transition: 'opacity 0.15s' }}
      onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = '0.75'}
      onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = '1'}
    >{val}</span>
  );
};

// ── Uploaded Date Cell ───────────────────────────────────────────────────────
const UploadedDateCell = ({ dateStr }: { dateStr: string }) => {
  const [showPopup, setShowPopup] = useState(false);
  if (!dateStr) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const d = new Date(dateStr);
  
  const shortFormat = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  const fullFormat = d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  const timeFormat = d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <span 
        onClick={(e) => { e.stopPropagation(); setShowPopup(!showPopup); }}
        style={{ cursor: 'pointer', borderBottom: '1.5px dotted var(--brand-teal)', color: 'var(--text-main)', fontWeight: 600, paddingBottom: 1 }}
      >
        {shortFormat}
      </span>
      {showPopup && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={(e) => { e.stopPropagation(); setShowPopup(false); }} />
          <div style={{
            position: 'absolute', bottom: '100%', left: '50%', transform: 'translate(-50%, -10px)',
            background: 'var(--surface-50)', border: '1px solid var(--surface-200)',
            boxShadow: '0 10px 40px rgba(0,0,0,0.15)', borderRadius: 12, padding: '14px 18px',
            zIndex: 50, display: 'flex', alignItems: 'center', gap: 14, minWidth: 220,
            color: 'var(--text-primary)', animation: 'queuePulse 0.3s cubic-bezier(0.16, 1, 0.3, 1)', cursor: 'default'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ background: 'rgba(8,131,149,0.1)', padding: 10, borderRadius: 10, display: 'flex' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--brand-teal)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
            </div>
            <div>
              <div style={{ color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 800, whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>{fullFormat}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 3, fontWeight: 600 }}>{timeFormat}</div>
            </div>
            <div style={{ position: 'absolute', bottom: '-7px', left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '7px solid transparent', borderRight: '7px solid transparent', borderTop: '7px solid var(--surface-200)' }}>
              <div style={{ position: 'absolute', top: '-8px', left: '-6px', width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '6px solid var(--surface-50)' }} />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// ── Confidence Bar ───────────────────────────────────────────────────────────
const ConfidenceBar = ({ score, status }: { score: number | null; status: string }) => {
  if (['pending', 'preprocessing', 'extracting'].includes(status)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontStyle: 'italic', animation: 'queuePulse 1.4s ease-in-out infinite' }}>
          {status === 'pending' ? 'Queued' : status === 'preprocessing' ? 'Prep' : 'Re-extracting AI...'}
        </span>
      </div>
    );
  }
  if (score !== null) {
    const pct = Math.round(score * 100);
    const color = pct >= 85 ? '#16a34a' : pct >= 70 ? '#F57C00' : '#dc2626';
    return (
      <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
        <span style={{ fontSize: '0.88rem', fontWeight: 700, color }}>{pct}%</span>
      </div>
    );
  }
  return <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>—</span>;
};



// ── Alert Orb — icon-only KPI indicator ────────────────────────────────────
const AlertOrb = ({ value, color, icon, tooltip, onClick, active }: any) => {
  const [hovered, setHovered] = useState(false);
  const isActive = value > 0;
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={isActive ? onClick : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: 48, height: 48, borderRadius: '50%', border: 'none',
          background: active ? color : isActive ? `${color}18` : 'var(--surface-100)',
          color: active ? 'white' : isActive ? color : 'var(--text-muted)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: isActive ? 'pointer' : 'default', transition: 'all 0.25s',
          boxShadow: active
            ? `0 0 0 4px ${color}30, 0 0 20px ${color}50`
            : isActive
            ? `0 0 0 0px ${color}00`
            : 'none',
          animation: isActive && !active ? `orbPulse_${color.replace(/[^a-z0-9]/gi,'_')} 2s ease-in-out infinite` : 'none',
          outline: 'none',
          position: 'relative',
        }}
      >
        {isActive && !active && (
          <span style={{
            position: 'absolute', inset: -3, borderRadius: '50%',
            border: `2px solid ${color}`,
            animation: 'orbRipple 2s ease-out infinite',
            pointerEvents: 'none',
          }} />
        )}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ filter: isActive ? `drop-shadow(0 0 4px ${color}80)` : 'none', transition: 'filter 0.3s' }}
        >{icon}</svg>
        {isActive && (
          <span style={{
            position: 'absolute', top: -4, right: -4,
            minWidth: 18, height: 18, borderRadius: 99,
            background: color, color: 'white', fontSize: '0.65rem', fontWeight: 900,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
            border: '2px solid white', boxShadow: `0 2px 6px ${color}60`,
          }}>{value}</span>
        )}
      </button>
      {hovered && (
        <div style={{
          position: 'absolute', bottom: '110%', left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(15,20,35,0.92)', color: 'white',
          padding: '7px 14px', borderRadius: 10, fontSize: '0.75rem', fontWeight: 600,
          whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 100,
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          backdropFilter: 'blur(8px)',
          letterSpacing: '0.02em',
        }}>
          <span style={{ color: isActive ? color : '#9ca3af', marginRight: 6 }}>{isActive ? '●' : '○'}</span>
          {tooltip}
          <div style={{ position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '6px solid rgba(15,20,35,0.92)' }} />
        </div>
      )}
    </div>
  );
};

// ── Main Component ────────────────────────────────────────────────────────────
export default function AdminQueue() {
  const navigate = useNavigate();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [highlightedGroup, setHighlightedGroup] = useState<{ ids: Set<string>; color: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [actionIsError, setActionIsError] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortCol, setSortCol] = useState<string>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [prfNameTemplate, setPrfNameTemplate] = useState(['provider_practice_number', 'prf_number', 'medical_scheme']);
  const nameSeparator = localStorage.getItem('prf_name_separator') || ' . ';

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [groupingId, setGroupingId] = useState<string | null>(null);
  const dragNodeRef = useRef<string | null>(null);

  useEffect(() => {
    fetchDocuments();
    api.get('/api/knowledge-base/extraction-settings')
      .then(r => { if (r.data.prf_name_template) setPrfNameTemplate(r.data.prf_name_template); })
      .catch(() => {});
  }, [filter, page]);

  useEffect(() => {
    const hasActive = documents.some(d => ['preprocessing', 'extracting', 'pending'].includes(d.ocr_status));
    if (!hasActive) return;
    const iv = setInterval(fetchDocuments, 10000);
    return () => clearInterval(iv);
  }, [documents]);

  const fetchDocuments = async () => {
    setLoading(true);
    try {
      const params: any = { page, page_size: 20, exclude_accepted: true };
      if (filter) params.ocr_status = filter;
      const res = await api.get('/api/documents/', { params });
      setDocuments(res.data.documents);
      setTotal(res.data.total);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const notify = (msg: string, err = false) => {
    setActionMessage(msg); setActionIsError(err);
    setTimeout(() => setActionMessage(''), 4000);
  };

  const handleReprocessAll = async () => {
    setProcessing(true);
    try {
      const res = await api.post('/api/documents/reprocess-pending');
      notify(`✓ Triggered ${res.data.document_ids.length} documents for AI extraction`);
      setTimeout(fetchDocuments, 2000);
    } catch (e: any) { notify(`✗ ${e.message}`, true); }
    finally { setProcessing(false); }
  };

  const handleStartFocusMode = () => {
    const ready = documents.filter(d => d.ocr_status === 'completed');
    if (!ready.length) { alert('No documents ready for verification.'); return; }
    const sorted = [...ready].sort((a, b) => (b.needs_hitl_review ? 1 : 0) - (a.needs_hitl_review ? 1 : 0));
    navigate(`/review/${sorted[0].id}`, { state: { isFocusMode: true, focusQueue: sorted.slice(1).map(d => d.id), totalInFocus: sorted.length } });
  };

  const handleDelete = async (doc: DocumentItem) => {
    if (!window.confirm(`Delete "${doc.original_filename}" permanently?`)) return;
    setDeletingId(doc.id);
    try {
      await api.delete(`/api/documents/${doc.id}`);
      notify(`✓ Deleted "${doc.original_filename}"`);
      setDocuments(p => p.filter(d => d.id !== doc.id));
      setTotal(p => p - 1);
    } catch (e: any) { notify(`✗ ${e.response?.data?.detail || e.message}`, true); }
    finally { setDeletingId(null); }
  };

  const handleUngroup = async (docId: string) => {
    try { await api.delete(`/api/documents/${docId}/ungroup`); notify('✓ Removed from bundle'); fetchDocuments(); }
    catch (e: any) { notify(`✗ ${e.message}`, true); }
  };

  const handleBatchDelete = async () => {
    if (!selected.size) return;
    if (!window.confirm(`Delete ${selected.size} selected document(s) permanently?`)) return;
    for (const id of selected) {
      const doc = documents.find(d => d.id === id);
      if (doc) await api.delete(`/api/documents/${id}`).catch(() => {});
    }
    notify(`✓ Deleted ${selected.size} documents`);
    setSelected(new Set());
    fetchDocuments();
  };

  const toggleSelect = (id: string) => setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => {
    if (selected.size === documents.length) setSelected(new Set());
    else setSelected(new Set(documents.map(d => d.id)));
  };

  const handleSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortIcon = (col: string) => (
    <span style={{ marginLeft: 4, opacity: sortCol === col ? 1 : 0.3, fontSize: '0.7rem' }}>
      {sortCol === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );

  // Drag handlers
  const handleDragStart = (e: React.DragEvent, id: string) => { dragNodeRef.current = id; setDraggingId(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); };
  const handleDragOver = (e: React.DragEvent, id: string) => { e.preventDefault(); if (dragNodeRef.current !== id) setDragOverId(id); };
  const handleDragEnd = () => { setDraggingId(null); setDragOverId(null); dragNodeRef.current = null; };
  const handleDrop = async (e: React.DragEvent, target: DocumentItem) => {
    e.preventDefault();
    const src = e.dataTransfer.getData('text/plain');
    if (!src || src === target.id) { handleDragEnd(); return; }
    setGroupingId(target.id); setDragOverId(null); setDraggingId(null);
    try {
      await api.post('/api/documents/group', { primary_id: target.id, secondary_id: src });
      notify(`✓ Bundled — ${target.original_filename} is Primary PRF`);
      const res = await api.get('/api/documents/', { params: { page, page_size: 20, exclude_accepted: true } });
      const all: DocumentItem[] = res.data.documents;
      const t = all.find(d => d.id === target.id);
      if (t?.group_id) setExpandedGroups(p => new Set(p).add(t.group_id!));
      setDocuments(all); setTotal(res.data.total);
    } catch (e: any) { notify(`✗ ${e.response?.data?.detail || e.message}`, true); }
    finally { setGroupingId(null); }
  };

  const getPrfName = (doc: DocumentItem) => {
    const d = doc.extracted_data;
    if (!d) return doc.original_filename;
    const parts = prfNameTemplate.map(k => (d[k] || '').toString().trim()).filter(Boolean);
    return parts.length ? parts.join(nameSeparator) : doc.original_filename;
  };

  // const formatDate = (s: string) => new Date(s).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // Sorted + filtered docs
  const filteredDocs = documents
    .filter(d => !searchQuery || getPrfName(d).toLowerCase().includes(searchQuery.toLowerCase()) || d.original_filename.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      let av: any, bv: any;
      if (sortCol === 'name') { av = getPrfName(a); bv = getPrfName(b); }
      else if (sortCol === 'confidence') { av = a.ocr_confidence_avg || 0; bv = b.ocr_confidence_avg || 0; }
      else if (sortCol === 'status') { av = a.ocr_status; bv = b.ocr_status; }
      
      if (sortCol === 'created_at') {
         const ta = new Date(a.created_at).getTime() || 0;
         const tb = new Date(b.created_at).getTime() || 0;
         return sortDir === 'asc' ? ta - tb : tb - ta;
      }

      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

  // Group logic
  const groups = new Map<string, DocumentItem[]>();
  const standalone: DocumentItem[] = [];
  for (const doc of filteredDocs) {
    if (doc.group_id) {
      if (!groups.has(doc.group_id)) groups.set(doc.group_id, []);
      groups.get(doc.group_id)!.push(doc);
    } else standalone.push(doc);
  }
  groups.forEach(docs => docs.sort((a, b) => (b.is_group_primary ? 1 : 0) - (a.is_group_primary ? 1 : 0)));

  // KPI counts
  const pendingCount = documents.filter(d => ['pending', 'failed'].includes(d.ocr_status)).length;
  const processingCount = documents.filter(d => ['preprocessing', 'extracting'].includes(d.ocr_status)).length;
  const verifyCount = documents.filter(d => d.ocr_status === 'completed').length;
  const failedCount = documents.filter(d => d.ocr_status === 'failed').length;

  // KPI click — push matching docs to top and pulsate them
  const handleKpiClick = (matcher: (d: DocumentItem) => boolean, color: string) => {
    const matchedIds = new Set(documents.filter(matcher).map(d => d.id));
    if (matchedIds.size === 0) return;
    setHighlightedGroup({ ids: matchedIds, color });
    // Move matched docs to the front of the list
    setDocuments(prev => [
      ...prev.filter(d => matchedIds.has(d.id)),
      ...prev.filter(d => !matchedIds.has(d.id)),
    ]);
    // Auto-clear after 4s
    setTimeout(() => setHighlightedGroup(null), 4000);
  };

  const FILTERS = [
    { label: 'All Documents', value: '' },
    { label: 'Queued', value: 'pending' },
    { label: 'Processing', value: 'preprocessing' },
    { label: 'Extracting', value: 'extracting' },
    { label: 'Needs Verify', value: 'completed' },
    { label: 'Failed', value: 'failed' },
  ];

  // Row renderer
  const renderRow = (doc: DocumentItem, isAttach = false) => {
    const isDragging = draggingId === doc.id;
    const isOver = dragOverId === doc.id;
    const isGrouping = groupingId === doc.id;
    const isSelectable = !isAttach;

    return (
      <tr key={doc.id}
        draggable={!isAttach}
        onDragStart={!isAttach ? e => handleDragStart(e, doc.id) : undefined}
        onDragOver={!isAttach ? e => handleDragOver(e, doc.id) : undefined}
        onDragLeave={!isAttach ? () => setDragOverId(null) : undefined}
        onDrop={!isAttach ? e => handleDrop(e, doc) : undefined}
        onDragEnd={!isAttach ? handleDragEnd : undefined}
        style={{
          opacity: isDragging ? 0.35 : 1,
          cursor: isAttach ? 'default' : 'grab',
          background: highlightedGroup?.ids.has(doc.id)
            ? `${highlightedGroup.color}12`
            : isOver ? 'rgba(8,131,149,0.05)' : isAttach ? 'rgba(248,249,252,0.7)' : selected.has(doc.id) ? 'rgba(8,131,149,0.04)' : undefined,
          outline: highlightedGroup?.ids.has(doc.id)
            ? `2px solid ${highlightedGroup.color}`
            : isOver ? '2px dashed var(--brand-teal)' : isGrouping ? '2px solid var(--brand-teal)' : 'none',
          outlineOffset: -2,
          transition: 'all 0.15s ease',
          animation: highlightedGroup?.ids.has(doc.id) ? 'rowHighlightPulse 1.8s ease-in-out infinite' : 'none',
        }}
      >
        {/* Checkbox */}
        <td style={{ width: 44, paddingLeft: 16 }}>
          {isSelectable && (
            <input type="checkbox" checked={selected.has(doc.id)} onChange={() => toggleSelect(doc.id)}
              style={{ width: 16, height: 16, accentColor: 'var(--brand-teal)', cursor: 'pointer' }} />
          )}
        </td>

        {/* Filename */}
        <td style={{ maxWidth: 320, paddingLeft: isAttach ? 48 : undefined }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {!isAttach && (
              <span style={{ color: 'var(--text-muted)', fontSize: '1rem', cursor: 'grab', lineHeight: 1, flexShrink: 0 }} title="Drag to bundle">⠿</span>
            )}
            {isAttach
              ? <span style={{ color: 'var(--brand-teal)', flexShrink: 0 }}>🔗</span>
              : doc.group_id
                ? <span style={{ fontSize: '0.68rem', fontWeight: 800, padding: '2px 7px', borderRadius: 4, background: 'rgba(8,131,149,0.12)', color: 'var(--brand-teal)', flexShrink: 0 }}>PRF</span>
                : null
            }
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontWeight: isAttach ? 400 : 600, fontSize: '0.88rem',
                color: isAttach ? 'var(--text-secondary)' : 'var(--text-primary)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }}>
                {isAttach ? doc.original_filename : getPrfName(doc)}
              </div>
              {isOver && <div style={{ fontSize: '0.7rem', color: 'var(--brand-teal)', fontWeight: 700, marginTop: 3 }}>↓ Drop to set as Primary PRF</div>}
            </div>
          </div>
        </td>

        {/* Type */}
        <td><EditableDocumentType doc={doc} onUpdate={(id, t) => setDocuments(p => p.map(d => d.id === id ? { ...d, document_type: t } : d))} /></td>

        {/* Confidence */}
        <td style={{ minWidth: 160 }}>
          <ConfidenceBar score={doc.ocr_confidence_avg} status={doc.ocr_status} />
        </td>

        {/* Flagged */}
        <td style={{ textAlign: 'center' }}>
          {doc.needs_hitl_review
            ? <span title="Flagged for review" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.72rem', fontWeight: 700, color: '#C2185B', background: '#fce7f3', padding: '3px 10px', borderRadius: 99 }}>⚑ Flagged</span>
            : <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>—</span>
          }
        </td>

        {/* Uploaded */}
        <td style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
          <UploadedDateCell dateStr={doc.created_at} />
        </td>

        {/* Actions */}
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', paddingRight: 16 }}>
            {doc.ocr_status === 'completed' && (
              <button
                onClick={() => {
                  const flaggedFields = doc.needs_hitl_review ? getFlaggedFields(doc) : [];
                  navigate(`/review/${doc.id}`, { state: { flaggedFields } });
                }}
                style={{
                  padding: '5px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  fontSize: '0.78rem', fontWeight: 700, whiteSpace: 'nowrap', transition: 'all 0.2s',
                  background: doc.needs_hitl_review ? '#C2185B' : 'var(--brand-teal)', color: 'white',
                  boxShadow: doc.needs_hitl_review ? '0 2px 8px rgba(194,24,91,0.3)' : '0 2px 8px rgba(8,131,149,0.3)',
                }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.transform = ''}
              >
                {doc.needs_hitl_review ? '⚑ Review' : '✓ Verify'}
              </button>
            )}
            {doc.group_id && (
              <button onClick={() => handleUngroup(doc.id)} title={isAttach ? 'Remove from bundle' : 'Dissolve bundle'}
                style={{ padding: '4px 10px', borderRadius: 7, border: '1px solid rgba(245,124,0,0.3)', color: '#F57C00', background: 'transparent', fontSize: '0.72rem', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
                {isAttach ? '✕ Remove' : '⊘ Ungroup'}
              </button>
            )}
            <button onClick={() => handleDelete(doc)} disabled={deletingId === doc.id}
              title="Delete permanently"
              style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid rgba(220,38,38,0.2)', color: '#dc2626', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s', flexShrink: 0 }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(220,38,38,0.08)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
              {deletingId === doc.id
                ? <div style={{ width: 12, height: 12, border: '2px solid #dc2626', borderTopColor: 'transparent', borderRadius: '50%', animation: 'queueSpin 0.7s linear infinite' }} />
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
              }
            </button>
          </div>
        </td>
      </tr>
    );
  };

  const renderGroupRows = (gid: string, docs: DocumentItem[]) => {
    const primary = docs.find(d => d.is_group_primary) || docs[0];
    const attachments = docs.filter(d => !d.is_group_primary);
    const isExpanded = expandedGroups.has(gid);
    return (
      <>
        <tr key={primary.id}
          draggable onDragStart={e => handleDragStart(e, primary.id)} onDragOver={e => handleDragOver(e, primary.id)}
          onDragLeave={() => setDragOverId(null)} onDrop={e => handleDrop(e, primary)} onDragEnd={handleDragEnd}
          style={{
            opacity: draggingId === primary.id ? 0.35 : 1, cursor: 'grab', transition: 'all 0.15s',
            background: dragOverId === primary.id ? 'rgba(8,131,149,0.05)' : selected.has(primary.id) ? 'rgba(8,131,149,0.04)' : undefined,
            outline: dragOverId === primary.id ? '2px dashed var(--brand-teal)' : 'none', outlineOffset: -2,
          }}
        >
          {/* Checkbox */}
          <td style={{ width: 44, paddingLeft: 16 }}>
            <input type="checkbox" checked={selected.has(primary.id)} onChange={() => toggleSelect(primary.id)}
              style={{ width: 16, height: 16, accentColor: 'var(--brand-teal)', cursor: 'pointer' }} />
          </td>
          {/* Filename with expand */}
          <td style={{ maxWidth: 320 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button onClick={() => setExpandedGroups(p => { const n = new Set(p); n.has(gid) ? n.delete(gid) : n.add(gid); return n; })}
                style={{ width: 20, height: 20, border: '1px solid var(--surface-200)', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: 'var(--surface-50)', color: 'var(--text-secondary)', fontSize: '0.7rem', flexShrink: 0, padding: 0, fontWeight: 700 }}>
                {isExpanded ? '▾' : '▸'}
              </button>
              <span style={{ color: 'var(--text-muted)', cursor: 'grab', flexShrink: 0 }}>⠿</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', fontWeight: 800, padding: '2px 8px', borderRadius: 4, background: 'rgba(8,131,149,0.12)', color: 'var(--brand-teal)', flexShrink: 0 }}>
                📎 {docs.length} · PRF
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{getPrfName(primary)}</div>
                {primary.extracted_data && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{primary.original_filename}</div>}
                {dragOverId === primary.id && <div style={{ fontSize: '0.7rem', color: 'var(--brand-teal)', fontWeight: 700, marginTop: 3 }}>↓ Drop to add to bundle</div>}
              </div>
            </div>
          </td>
          <td><EditableDocumentType doc={primary} onUpdate={(id, t) => setDocuments(p => p.map(d => d.id === id ? { ...d, document_type: t } : d))} /></td>
          <td style={{ minWidth: 160 }}><ConfidenceBar score={primary.ocr_confidence_avg} status={primary.ocr_status} /></td>
          <td style={{ textAlign: 'center' }}>
            {primary.needs_hitl_review
              ? <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#C2185B', background: '#fce7f3', padding: '3px 10px', borderRadius: 99 }}>⚑ Flagged</span>
              : <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>—</span>}
          </td>
          <td style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}><UploadedDateCell dateStr={primary.created_at} /></td>
          <td>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', paddingRight: 16 }}>
              {primary.ocr_status === 'completed' && (
                <button onClick={() => {
                  const flaggedFields = primary.needs_hitl_review ? getFlaggedFields(primary) : [];
                  navigate(`/review/${primary.id}`, { state: { flaggedFields } });
                }}
                  style={{ padding: '5px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700, background: primary.needs_hitl_review ? '#C2185B' : 'var(--brand-teal)', color: 'white', transition: 'all 0.2s' }}>
                  {primary.needs_hitl_review ? '⚑ Review' : '✓ Verify'}
                </button>
              )}
              <button onClick={() => handleUngroup(primary.id)}
                style={{ padding: '4px 10px', borderRadius: 7, border: '1px solid rgba(245,124,0,0.3)', color: '#F57C00', background: 'transparent', fontSize: '0.72rem', cursor: 'pointer', fontWeight: 600 }}>⊘ Ungroup</button>
              <button onClick={() => handleDelete(primary)} disabled={deletingId === primary.id}
                style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid rgba(220,38,38,0.2)', color: '#dc2626', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {deletingId === primary.id ? <div style={{ width: 12, height: 12, border: '2px solid #dc2626', borderTopColor: 'transparent', borderRadius: '50%', animation: 'queueSpin 0.7s linear infinite' }} /> : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>}
              </button>
            </div>
          </td>
        </tr>
        {isExpanded && attachments.map(att => renderRow(att, true))}
      </>
    );
  };

  return (
    <div className="page-content" style={{ padding: '28px 40px', maxWidth: 1600, margin: '0 auto' }}>
      <style>{`
        @keyframes queuePulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes queueSpin  { to{transform:rotate(360deg)} }
        @keyframes orbRipple  { 0%{transform:scale(1);opacity:0.7} 100%{transform:scale(1.7);opacity:0} }
        @keyframes rowHighlightPulse {
          0%,100% { box-shadow: none; }
          50% { box-shadow: inset 0 0 0 2px currentColor; }
        }
        @keyframes queueShimmer {
          0%  { opacity:0.5; transform: translateX(-20%); }
          50% { opacity:1; }
          100%{ opacity:0.5; transform: translateX(20%); }
        }
        .aq-th { cursor:pointer; user-select:none; white-space:nowrap; }
        .aq-th:hover { color: var(--brand-teal); }
        .aq-row:hover td { background: rgba(8,131,149,0.025); }
        .aq-table td, .aq-table th { padding: 11px 14px; }
        .aq-table th { font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.07em; color:var(--text-muted); background:var(--surface-50); border-bottom:2px solid var(--surface-200); }
        .aq-table td { border-bottom:1px solid var(--surface-100); vertical-align:middle; }
        .aq-table tbody tr:last-child td { border-bottom:none; }
        .aq-table th:first-child { border-top-left-radius: 15px; }
        .aq-table th:last-child { border-top-right-radius: 15px; }
        .aq-table tbody tr:last-child td:first-child { border-bottom-left-radius: 15px; }
        .aq-table tbody tr:last-child td:last-child { border-bottom-right-radius: 15px; }
      `}</style>

      {/* ── Page Header ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 900, color: 'var(--text-primary)', margin: '0 0 6px 0', letterSpacing: '-0.02em' }}>
            Verification
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button onClick={fetchDocuments}
            style={{ padding: '9px 18px', borderRadius: 10, border: '1px solid var(--surface-200)', background: 'white', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>
            Refresh
          </button>
          <button onClick={() => navigate('/upload')}
            style={{ padding: '9px 20px', borderRadius: 10, border: 'none', background: 'var(--brand-teal)', color: 'white', fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 4px 14px rgba(8,131,149,0.3)', transition: 'all 0.2s' }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.transform = ''}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
            Upload PRF
          </button>
        </div>
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Alert Orbs */}
        {(processingCount > 0 || failedCount > 0 || highlightedGroup) && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginRight: 8 }}>
            {processingCount > 0 && (
              <AlertOrb
                value={processingCount} color="#7c3aed"
                tooltip={`${processingCount} document${processingCount !== 1 ? 's' : ''} currently being AI-extracted — click to prioritise`}
                active={highlightedGroup?.color === '#7c3aed'}
                onClick={() => handleKpiClick(d => ['preprocessing','extracting'].includes(d.ocr_status), '#7c3aed')}
                icon={<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />}
              />
            )}
            {failedCount > 0 && (
              <AlertOrb
                value={failedCount} color="#dc2626"
                tooltip={`${failedCount} document${failedCount !== 1 ? 's' : ''} failed AI extraction — click to surface and reprocess`}
                active={highlightedGroup?.color === '#dc2626'}
                onClick={() => handleKpiClick(d => d.ocr_status === 'failed', '#dc2626')}
                icon={<><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>}
              />
            )}
            {highlightedGroup && (
              <button onClick={() => setHighlightedGroup(null)}
                style={{ marginLeft: 4, padding: '6px 14px', borderRadius: 99, border: `1px solid ${highlightedGroup.color}40`, background: `${highlightedGroup.color}10`, color: highlightedGroup.color, fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', transition: 'all 0.2s' }}>
                ✕ Clear
              </button>
            )}
          </div>
        )}

        {/* Search */}
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 360 }}>
          <svg style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search by patient, PRF number, scheme…"
            style={{ width: '100%', paddingLeft: 38, paddingRight: 14, paddingTop: 9, paddingBottom: 9, borderRadius: 10, border: '1px solid var(--surface-200)', fontSize: '0.85rem', outline: 'none', background: 'white', color: 'var(--text-primary)' }} />
        </div>

        {/* Filter tabs */}
        <div style={{ display: 'flex', background: 'var(--surface-100)', borderRadius: 10, padding: 3, gap: 2, flexWrap: 'wrap' }}>
          {FILTERS.map(f => (
            <button key={f.value} onClick={() => { setFilter(f.value); setPage(1); }}
              style={{
                padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600, transition: 'all 0.15s',
                background: filter === f.value ? 'white' : 'transparent',
                color: filter === f.value ? 'var(--brand-teal)' : 'var(--text-muted)',
                boxShadow: filter === f.value ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
              }}>
              {f.label}
            </button>
          ))}
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 10, marginLeft: 'auto' }}>
          <button onClick={handleReprocessAll} disabled={processing || pendingCount === 0}
            style={{ padding: '8px 18px', borderRadius: 10, border: '1px solid rgba(8,131,149,0.3)', background: 'rgba(8,131,149,0.06)', color: 'var(--brand-teal)', fontWeight: 700, fontSize: '0.82rem', cursor: pendingCount === 0 ? 'not-allowed' : 'pointer', opacity: pendingCount === 0 ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 7, transition: 'all 0.2s' }}>
            {processing ? <div style={{ width: 13, height: 13, border: '2px solid var(--brand-teal)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'queueSpin 0.7s linear infinite' }} /> : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>}
            Process All {pendingCount > 0 && `(${pendingCount})`}
          </button>

          <button onClick={handleStartFocusMode} disabled={verifyCount === 0}
            style={{ padding: '8px 20px', borderRadius: 10, border: 'none', background: verifyCount > 0 ? 'white' : 'var(--surface-200)', color: verifyCount > 0 ? 'var(--brand-teal)' : 'var(--text-muted)', fontWeight: 800, fontSize: '0.82rem', cursor: verifyCount === 0 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 7, boxShadow: verifyCount > 0 ? '0 4px 20px rgba(0,0,0,0.12)' : 'none', transition: 'all 0.2s' }}
            onMouseEnter={e => { if (verifyCount > 0) { (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 8px 28px rgba(0,0,0,0.18)'; } }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = ''; (e.currentTarget as HTMLElement).style.boxShadow = verifyCount > 0 ? '0 4px 20px rgba(0,0,0,0.12)' : 'none'; }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            Focus Mode {verifyCount > 0 && `(${verifyCount})`}
          </button>

          {selected.size > 0 && (
            <button onClick={handleBatchDelete}
              style={{ padding: '8px 18px', borderRadius: 10, border: '1px solid rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.06)', color: '#dc2626', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7, transition: 'all 0.2s' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
              Delete {selected.size}
            </button>
          )}
        </div>
      </div>

      {/* ── Action Toast ──────────────────────────────────────────────────── */}
      {actionMessage && (
        <div style={{
          marginBottom: 16, padding: '10px 20px', borderRadius: 10, fontSize: '0.85rem', fontWeight: 600,
          background: actionIsError ? 'rgba(220,38,38,0.07)' : 'rgba(22,163,74,0.07)',
          color: actionIsError ? '#dc2626' : '#16a34a',
          border: `1px solid ${actionIsError ? 'rgba(220,38,38,0.2)' : 'rgba(22,163,74,0.2)'}`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          {actionIsError ? '✗' : '✓'} {actionMessage}
        </div>
      )}

      {/* ── Table ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <div style={{ width: 36, height: 36, border: '3px solid var(--surface-200)', borderTopColor: 'var(--brand-teal)', borderRadius: '50%', animation: 'queueSpin 0.8s linear infinite' }} />
        </div>
      ) : filteredDocs.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 0', gap: 16, color: 'var(--text-muted)' }}>
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" style={{ opacity: 0.3 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
          <div style={{ fontWeight: 700, fontSize: '1rem' }}>No documents found</div>
          <div style={{ fontSize: '0.85rem' }}>Upload PRF documents to begin processing.</div>
          <button onClick={() => navigate('/upload')} style={{ marginTop: 8, padding: '10px 24px', borderRadius: 10, background: 'var(--brand-teal)', color: 'white', border: 'none', fontWeight: 700, cursor: 'pointer' }}>
            Upload PRF
          </button>
        </div>
      ) : (
        <>
          <div style={{ background: 'white', border: '1px solid var(--surface-200)', borderRadius: 16, overflow: 'visible', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <table className="aq-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ width: 44, paddingLeft: 16 }}>
                    <input type="checkbox" checked={selected.size === filteredDocs.length && filteredDocs.length > 0} onChange={toggleAll}
                      style={{ width: 16, height: 16, accentColor: 'var(--brand-teal)', cursor: 'pointer' }} />
                  </th>
                  <th className="aq-th" style={{ maxWidth: 320 }} onClick={() => handleSort('name')}>Document / PRF {sortIcon('name')}</th>
                  <th>Type</th>
                  <th className="aq-th" style={{ minWidth: 160 }} onClick={() => handleSort('confidence')}>AI Confidence {sortIcon('confidence')}</th>
                  <th style={{ textAlign: 'center' }}>Flagged</th>
                  <th className="aq-th" onClick={() => handleSort('created_at')}>Uploaded {sortIcon('created_at')}</th>
                  <th style={{ textAlign: 'right', paddingRight: 16 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(groups.entries()).map(([gid, docs]) => renderGroupRows(gid, docs))}
                {standalone.map(doc => renderRow(doc, false))}
              </tbody>
            </table>
          </div>

          {/* ── Pagination ─────────────────────────────────────────────── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, flexWrap: 'wrap', gap: 12 }}>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              Showing <strong style={{ color: 'var(--text-primary)' }}>{filteredDocs.length}</strong> of <strong style={{ color: 'var(--text-primary)' }}>{total}</strong> documents
              {selected.size > 0 && <span style={{ marginLeft: 12, color: 'var(--brand-teal)', fontWeight: 700 }}>· {selected.size} selected</span>}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
                style={{ padding: '7px 16px', borderRadius: 9, border: '1px solid var(--surface-200)', background: 'white', color: page <= 1 ? 'var(--text-muted)' : 'var(--text-primary)', fontSize: '0.82rem', fontWeight: 600, cursor: page <= 1 ? 'not-allowed' : 'pointer', opacity: page <= 1 ? 0.5 : 1 }}>
                ← Previous
              </button>
              <span style={{ padding: '7px 14px', fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-secondary)', background: 'var(--surface-50)', borderRadius: 9, border: '1px solid var(--surface-200)' }}>
                Page {page}
              </span>
              <button disabled={page * 20 >= total} onClick={() => setPage(p => p + 1)}
                style={{ padding: '7px 16px', borderRadius: 9, border: '1px solid var(--surface-200)', background: 'white', color: page * 20 >= total ? 'var(--text-muted)' : 'var(--text-primary)', fontSize: '0.82rem', fontWeight: 600, cursor: page * 20 >= total ? 'not-allowed' : 'pointer', opacity: page * 20 >= total ? 0.5 : 1 }}>
                Next →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
