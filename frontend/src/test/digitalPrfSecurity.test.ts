/**
 * Unit tests: Auto-save deduplication logic (security optimization from walkthrough)
 *
 * The `doSave` function in DigitalPRFForm compares the current payload JSON
 * against the last sent payload to skip redundant API calls. These tests
 * verify that logic in isolation (extracted as a pure utility so it's testable).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Pure utility extracted from doSave ─────────────────────────────────────
// We test the diffing logic as a standalone function to avoid needing to
// mount the full 5000-line DigitalPRFForm component.
function shouldSkipSave(currentPayload: object, lastSavedRef: { current: string | null }): boolean {
  const serialized = JSON.stringify(currentPayload);
  if (serialized === lastSavedRef.current) return true;
  lastSavedRef.current = serialized;
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// Deduplication / diff-before-save
// ══════════════════════════════════════════════════════════════════════════════
describe('Auto-save deduplication: shouldSkipSave()', () => {
  let lastSavedRef: { current: string | null };

  beforeEach(() => {
    lastSavedRef = { current: null };
  });

  it('does NOT skip on the very first save (ref is null)', () => {
    const payload = { form_data: { patient_name: 'John' } };
    expect(shouldSkipSave(payload, lastSavedRef)).toBe(false);
  });

  it('stores the serialized payload after the first save', () => {
    const payload = { form_data: { patient_name: 'John' } };
    shouldSkipSave(payload, lastSavedRef);
    expect(lastSavedRef.current).toBe(JSON.stringify(payload));
  });

  it('skips when called a second time with an identical payload', () => {
    const payload = { form_data: { patient_name: 'John' } };
    shouldSkipSave(payload, lastSavedRef); // first call — saves ref
    expect(shouldSkipSave(payload, lastSavedRef)).toBe(true); // second call — identical
  });

  it('does NOT skip when a field changes', () => {
    const first = { form_data: { patient_name: 'John' } };
    const second = { form_data: { patient_name: 'Jane' } };
    shouldSkipSave(first, lastSavedRef);
    expect(shouldSkipSave(second, lastSavedRef)).toBe(false);
  });

  it('does NOT skip when a new field is added', () => {
    const first = { form_data: { patient_name: 'John' } };
    const second = { form_data: { patient_name: 'John', age: '45' } };
    shouldSkipSave(first, lastSavedRef);
    expect(shouldSkipSave(second, lastSavedRef)).toBe(false);
  });

  it('skips for deeply-equal nested objects', () => {
    const payload = { form_data: { vitals: [{ hr: 72, bp: '120/80' }] } };
    shouldSkipSave(payload, lastSavedRef);
    // Same structure, same values — must skip
    const identicalPayload = { form_data: { vitals: [{ hr: 72, bp: '120/80' }] } };
    expect(shouldSkipSave(identicalPayload, lastSavedRef)).toBe(true);
  });

  it('does NOT skip when a vitals entry changes (patient condition update)', () => {
    const first = { form_data: { vitals: [{ hr: 72, bp: '120/80' }] } };
    const second = { form_data: { vitals: [{ hr: 98, bp: '90/60' }] } }; // deteriorating
    shouldSkipSave(first, lastSavedRef);
    expect(shouldSkipSave(second, lastSavedRef)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GPS Spoofing velocity helper (mirrors the backend Python logic in JS)
// ══════════════════════════════════════════════════════════════════════════════

/** Haversine distance in km between two lat/lng pairs */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isSpoofingSuspected(
  prevLat: number, prevLng: number, prevTime: Date,
  newLat: number, newLng: number, newTime: Date,
  thresholdKmh = 150,
): boolean {
  const distKm = haversineKm(prevLat, prevLng, newLat, newLng);
  const timeHrs = (newTime.getTime() - prevTime.getTime()) / 3_600_000;
  if (timeHrs <= 0) return false;
  return distKm / timeHrs > thresholdKmh;
}

describe('GPS Spoofing detection: velocity check', () => {
  const base = new Date('2026-05-23T10:00:00Z');
  // Durban coordinates
  const durbanLat = -29.8587, durbanLng = 31.0218;
  // Johannesburg coordinates (~570km from Durban)
  const jhbLat = -26.2041, jhbLng = 28.0473;

  it('does NOT flag an ambulance travelling at 60 km/h', () => {
    // ~600m apart in 1 minute = 36 km/h
    const prev = { lat: -29.8587, lng: 31.0218, time: base };
    const next = { lat: -29.8633, lng: 31.0218, time: new Date(base.getTime() + 60_000) };
    expect(isSpoofingSuspected(prev.lat, prev.lng, prev.time, next.lat, next.lng, next.time)).toBe(false);
  });

  it('flags teleportation from Durban to Johannesburg in 1 minute', () => {
    const oneMinuteLater = new Date(base.getTime() + 60_000);
    expect(isSpoofingSuspected(durbanLat, durbanLng, base, jhbLat, jhbLng, oneMinuteLater)).toBe(true);
  });

  it('does NOT flag the same Durban-to-JHB journey over 6 hours', () => {
    const sixHoursLater = new Date(base.getTime() + 6 * 3_600_000);
    expect(isSpoofingSuspected(durbanLat, durbanLng, base, jhbLat, jhbLng, sixHoursLater)).toBe(false);
  });

  it('does NOT flag identical coordinates (stationary ambulance)', () => {
    const fiveMinutesLater = new Date(base.getTime() + 5 * 60_000);
    expect(isSpoofingSuspected(durbanLat, durbanLng, base, durbanLat, durbanLng, fiveMinutesLater)).toBe(false);
  });

  it('haversineKm gives a reasonable distance between Durban and Johannesburg', () => {
    const dist = haversineKm(durbanLat, durbanLng, jhbLat, jhbLng);
    expect(dist).toBeGreaterThan(500);
    expect(dist).toBeLessThan(650);
  });
});
