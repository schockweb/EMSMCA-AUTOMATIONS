/**
 * StartShiftWizard — the "Start Shift" modal launched from ProviderLogin.
 *
 * Two steps: pick a vehicle, then multi-select the crew on it. On submit it
 * calls the passwordless shift-start endpoint and persists the crew session via
 * the shared crewSession helper, then routes to the crew dashboard.
 *
 * Raw axios (not api/client) — this is a crew_token flow and must not run
 * through the admin interceptor. The parent freezes background scroll for the
 * whole page, so this modal needs no scroll lock of its own.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import axios from 'axios';
import { grantHeaders } from '../../utils/portalGrant';
import { saveShiftSession } from '../../utils/crewSession';
import { checkVehicleInUse, confirmTakeOccupiedVehicle } from '../../utils/vehicleOccupancy';

export interface CrewOption {
  id: string;
  full_name: string;
  qualification: string;
  hpcsa_number: string | null;
}

export interface VehicleOption {
  id: string;
  callsign: string;
  registration_number: string;
}

interface StartShiftWizardProps {
  providerSlug: string | undefined;
  crewList: CrewOption[];
  vehicleList: VehicleOption[];
  onClose: () => void;
}

export default function StartShiftWizard({
  providerSlug,
  crewList,
  vehicleList,
  onClose,
}: StartShiftWizardProps) {
  const navigate = useNavigate();

  const [shiftStep, setShiftStep] = useState<1 | 2>(1);
  const [selectedVehicleId, setSelectedVehicleId] = useState('');
  const [selectedCrewIds, setSelectedCrewIds] = useState<string[]>([]);
  const [shiftLoading, setShiftLoading] = useState(false);
  const [shiftError, setShiftError] = useState('');
  const [checkingVehicleId, setCheckingVehicleId] = useState('');

  /**
   * Pick a vehicle — warning first if another crew is already on it.
   *
   * The check runs on TAP rather than on the list, so the picker stays clean
   * and the crew is only told about the one ambulance they actually reached
   * for. It fails open: an unanswerable check advances exactly as before.
   */
  const pickVehicle = async (v: VehicleOption) => {
    if (checkingVehicleId) return;          // ignore a double-tap mid-check
    setCheckingVehicleId(v.id);
    let occupied = null;
    try {
      occupied = await checkVehicleInUse(providerSlug, v.id);
    } finally {
      setCheckingVehicleId('');
    }
    if (occupied && !confirmTakeOccupiedVehicle(v.callsign, occupied)) return;
    setSelectedVehicleId(v.id);
    setShiftStep(2);
  };

  const toggleCrewSelection = (id: string) => {
    setSelectedCrewIds(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  };

  const handleStartShift = async (e: FormEvent) => {
    e.preventDefault();
    if (selectedCrewIds.length === 0) { setShiftError('Please select at least one crew member.'); return; }

    const primaryCrewId = selectedCrewIds[0];
    const assistingCrewIds = selectedCrewIds.slice(1);
    const partnerId = assistingCrewIds.length > 0 ? assistingCrewIds[0] : null;
    const partnerName = partnerId ? (crewList.find(c => c.id === partnerId)?.full_name || '') : '';
    const vehicleCallsign = vehicleList.find(v => v.id === selectedVehicleId)?.callsign || '';

    setShiftError('');
    setShiftLoading(true);
    try {
      const res = await axios.post('/api/crew/shift-start-by-id', {
        crew_id: primaryCrewId,
        provider_slug: providerSlug,
        partner_name: partnerName || undefined,
        vehicle_id: selectedVehicleId,
        vehicle_callsign: vehicleCallsign,
      }, { headers: grantHeaders(providerSlug) });
      const data = res.data;

      // First assisting crew → crew2_profile (backend hand-off).
      const partnerRaw = partnerId ? crewList.find(c => c.id === partnerId) : undefined;
      const partner = partnerRaw
        ? {
            id: partnerRaw.id,
            name: partnerRaw.full_name,
            full_name: partnerRaw.full_name,
            hpcsa_number: partnerRaw.hpcsa_number,
            qualification: partnerRaw.qualification,
          }
        : null;

      // All assisting crew (incl. the first partner) → extra_crew_profiles (UI).
      const extraCrew = assistingCrewIds
        .map(id => crewList.find(c => c.id === id))
        .filter(Boolean)
        .map(c => ({
          id: c!.id,
          name: c!.full_name,
          full_name: c!.full_name,
          hpcsa_number: c!.hpcsa_number,
          qualification: c!.qualification,
        }));

      const selectedVehicle = vehicleList.find(v => v.id === selectedVehicleId);
      const vehicle = selectedVehicle
        ? {
            id: selectedVehicle.id,
            callsign: selectedVehicle.callsign,
            registration: selectedVehicle.registration_number,
            vehicle_type: '',
          }
        : null;

      saveShiftSession({
        token: data.access_token,
        profile: {
          id: data.crew_id,
          name: data.full_name,
          provider_id: data.provider_id,
          provider_name: data.provider_name,
          provider_slug: data.provider_slug,
          qualification: data.qualification,
          hpcsa_number: data.hpcsa_number,
          role: data.role,
          partner_name: data.partner_name || '',
          vehicle_id: data.vehicle_id || '',
          vehicle_callsign: data.vehicle_callsign || '',
        },
        partner,
        extraCrew,
        vehicle,
      });

      navigate(`/${providerSlug}/crew/dashboard`);
    } catch (err: any) {
      setShiftError(err.response?.data?.detail || 'Failed to start shift. Try again.');
    }
    setShiftLoading(false);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16,
    }}>
      <div style={{
        background: '#fff',
        borderRadius: '16px',
        width: '100%',
        maxWidth: '460px',
        boxShadow: '0 24px 48px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
        overflow: 'hidden',
        animation: 'fadeInUp 0.25s ease-out',
        display: 'flex', flexDirection: 'column',
        maxHeight: '85vh'
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px 16px', borderBottom: '1px solid #f0f0f0',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#111827', letterSpacing: '-0.01em' }}>
              {shiftStep === 1 ? 'Select Ambulance' : 'Select Crew'}
            </div>
            <div style={{ fontSize: '0.78rem', color: '#9ca3af', marginTop: 2, fontWeight: 400 }}>
              {shiftStep === 1 ? 'Choose the vehicle for this shift' : 'Tap to select crew on this vehicle'}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{
            width: 30, height: 30, background: 'transparent', border: '1px solid #e5e7eb',
            color: '#9ca3af', cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1,
            borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 0, transition: 'all 0.15s',
          }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px', overflowY: 'auto' }}>
          {shiftError && <div className="login-error" style={{ marginBottom: '14px', fontSize: '0.8rem' }}>{shiftError}</div>}

          {shiftStep === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {vehicleList.map(v => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => { void pickVehicle(v); }}
                  disabled={!!checkingVehicleId}
                  style={{
                    padding: '14px 16px', borderRadius: '10px', border: '1px solid #e5e7eb',
                    background: '#fff',
                    textAlign: 'left', cursor: checkingVehicleId ? 'wait' : 'pointer', transition: 'all 0.15s',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    opacity: checkingVehicleId && checkingVehicleId !== v.id ? 0.5 : 1,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#1f2937' }}>{v.callsign}</div>
                    <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 1 }}>{v.registration_number}</div>
                  </div>
                  <span style={{ color: '#d1d5db', fontSize: '1rem' }}>{checkingVehicleId === v.id ? '…' : '›'}</span>
                </button>
              ))}
              {vehicleList.length === 0 && (
                <div style={{ textAlign: 'center', padding: '32px 16px', color: '#9ca3af', fontSize: '0.85rem' }}>
                  No vehicles available
                </div>
              )}
            </div>
          )}

          {shiftStep === 2 && (
            <form onSubmit={handleStartShift}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '20px' }}>
                {crewList.map(c => {
                  const isSelected = selectedCrewIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleCrewSelection(c.id)}
                      style={{
                        padding: '12px 14px', borderRadius: '10px',
                        border: '1px solid',
                        borderColor: isSelected ? 'var(--brand-teal)' : '#e5e7eb',
                        background: isSelected ? 'rgba(20,184,166,0.06)' : '#fff',
                        textAlign: 'left', cursor: 'pointer', transition: 'all 0.15s',
                        display: 'flex', alignItems: 'center', gap: 10,
                      }}
                    >
                      <div style={{
                        width: 18, height: 18, borderRadius: '4px', border: '1.5px solid',
                        borderColor: isSelected ? 'var(--brand-teal)' : '#d1d5db',
                        background: isSelected ? 'var(--brand-teal)' : '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, transition: 'all 0.15s',
                      }}>
                        {isSelected && <span style={{ color: '#fff', fontSize: '12px', lineHeight: 1 }}>✓</span>}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: '0.85rem', color: '#1f2937' }}>{c.full_name}</div>
                        <div style={{ fontSize: '0.7rem', color: '#9ca3af', marginTop: 1 }}>{c.qualification}</div>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div style={{ display: 'flex', gap: '10px', borderTop: '1px solid #f0f0f0', paddingTop: '16px' }}>
                <button
                  type="button"
                  onClick={() => setShiftStep(1)}
                  className="btn btn-lg"
                  style={{
                    flex: '0 0 auto', padding: '10px 20px',
                    background: '#fff', color: '#6b7280', border: '1px solid #e5e7eb',
                    fontSize: '0.82rem', fontWeight: 500,
                  }}
                >
                  Back
                </button>
                {/* btn-primary (brand teal) to match the "Start Shift" button on
                    the login page that opens this wizard, and the admin sign-in
                    above it - one colour for the whole crew entry flow. */}
                <button type="submit" className="btn btn-primary btn-lg" style={{ flex: 1, fontSize: '0.82rem', fontWeight: 600 }} disabled={shiftLoading || selectedCrewIds.length === 0}>
                  {shiftLoading ? 'Starting...' : `Start Shift · ${selectedCrewIds.length} selected`}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
