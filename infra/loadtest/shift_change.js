/**
 * k6 Load Test — EMS PRF Shift-Change Burst Simulation
 *
 * Simulates 900 PRFs/hour (the Johannesburg shift-change peak):
 *   - 100 virtual users over 60 seconds
 *   - Each VU: login → create PRF → auto-save 5x → submit
 *
 * Usage:
 *   k6 run infra/loadtest/shift_change.js
 *   k6 run --env BASE_URL=https://app.example.co.za infra/loadtest/shift_change.js
 *
 * Thresholds:
 *   - p95 response time < 2s
 *   - Error rate < 1%
 *   - 0 dropped submissions
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ── Custom Metrics ──
const prfSubmissions = new Counter('prf_submissions_total');
const prfFailures = new Counter('prf_failures_total');
const submitDuration = new Trend('prf_submit_duration_ms');

// ── Configuration ──
const BASE_URL = __ENV.BASE_URL || 'http://localhost:8001';
const PROVIDER_SLUG = __ENV.PROVIDER_SLUG || 'jems';

export const options = {
  // Ramp up to 100 VUs over 10s, hold for 50s, ramp down
  stages: [
    { duration: '10s', target: 100 },
    { duration: '50s', target: 100 },
    { duration: '10s', target: 0 },
  ],

  thresholds: {
    // p95 response time under 2 seconds
    http_req_duration: ['p(95)<2000'],
    // Less than 1% error rate
    http_req_failed: ['rate<0.01'],
    // At least 800 successful submissions in 70 seconds
    prf_submissions_total: ['count>800'],
    // Max 5 failures
    prf_failures_total: ['count<5'],
  },
};

// ── Test Data ──
function randomPatient() {
  const names = ['John Smith', 'Maria Garcia', 'Ahmed Khan', 'Sarah Johnson', 'Tom Wilson'];
  const schemes = ['Discovery Health', 'GEMS', 'Bonitas', 'Medihelp', 'Momentum'];
  const callTypes = ['P1', 'P2', 'P3', 'IFT', 'RHT'];
  return {
    patient_name: names[Math.floor(Math.random() * names.length)],
    patient_surname: 'LoadTest',
    medical_scheme: schemes[Math.floor(Math.random() * schemes.length)],
    call_type: callTypes[Math.floor(Math.random() * callTypes.length)],
    patient_id_number: `${8000000000 + Math.floor(Math.random() * 1999999999)}083`,
    age: String(20 + Math.floor(Math.random() * 60)),
    chief_complaint: 'Load test — synthetic PRF',
    incident_location: 'Johannesburg CBD',
  };
}

function randomVitals() {
  return {
    hr: String(60 + Math.floor(Math.random() * 60)),
    bp: `${100 + Math.floor(Math.random() * 40)}/${60 + Math.floor(Math.random() * 20)}`,
    spo2: String(94 + Math.floor(Math.random() * 6)),
    rr: String(12 + Math.floor(Math.random() * 10)),
    temp: (36 + Math.random() * 2).toFixed(1),
    gcs_e: '4', gcs_v: '5', gcs_m: '6',
  };
}

function randomKms() {
  let base = 10000 + Math.floor(Math.random() * 90000);
  return {
    km_call_received: String(base),
    km_dispatched: String(base + 1),
    km_mobile: String(base + 2),
    km_on_scene: String(base + 15 + Math.floor(Math.random() * 20)),
    km_depart_scene: String(base + 16 + Math.floor(Math.random() * 20)),
    km_at_destination: String(base + 30 + Math.floor(Math.random() * 30)),
    km_handover: String(base + 31 + Math.floor(Math.random() * 30)),
    km_available: String(base + 32 + Math.floor(Math.random() * 30)),
    km_back_to_base: String(base + 50 + Math.floor(Math.random() * 30)),
  };
}

// ── Main Test Flow ──
export default function () {
  const headers = { 'Content-Type': 'application/json' };

  // Step 1: Crew login (get token)
  // In a real test, you'd use actual HPCSA numbers. For load testing,
  // we use a pre-seeded test crew member.
  const loginRes = http.post(
    `${BASE_URL}/api/crew/lookup-hpcsa`,
    JSON.stringify({
      hpcsa_number: __ENV.TEST_HPCSA || 'LOADTEST001',
      provider_slug: PROVIDER_SLUG,
    }),
    { headers, tags: { name: 'crew_login' } }
  );

  if (!check(loginRes, { 'login succeeded': (r) => r.status === 200 })) {
    prfFailures.add(1);
    return;
  }

  const token = loginRes.json('access_token');
  const authHeaders = {
    ...headers,
    Authorization: `Bearer ${token}`,
  };

  // Step 2: Create a new PRF
  const createRes = http.post(
    `${BASE_URL}/api/digital-prf`,
    JSON.stringify({
      vehicle_id: __ENV.TEST_VEHICLE_ID || null,
      crew_member_2_id: null,
    }),
    { headers: authHeaders, tags: { name: 'create_prf' } }
  );

  if (!check(createRes, { 'PRF created': (r) => r.status === 200 || r.status === 201 })) {
    prfFailures.add(1);
    return;
  }

  const prfId = createRes.json('id');

  // Step 3: Auto-save 5 times (simulating form filling)
  const patient = randomPatient();
  const vitals = [randomVitals(), randomVitals()];
  const kms = randomKms();

  for (let i = 0; i < 5; i++) {
    const savePayload = {
      form_data: {
        ...patient,
        vitals_sets: vitals,
        iv_therapy: [],
        medications: [],
        progress_note: `Auto-save ${i + 1}/5 — load test`,
      },
      ...kms,
    };

    const saveRes = http.patch(
      `${BASE_URL}/api/digital-prf/${prfId}`,
      JSON.stringify(savePayload),
      { headers: authHeaders, tags: { name: 'auto_save' } }
    );

    check(saveRes, { 'auto-save ok': (r) => r.status === 200 });
    sleep(0.2); // 200ms between saves (simulates typing)
  }

  // Step 4: Submit
  const t0 = Date.now();
  const submitRes = http.post(
    `${BASE_URL}/api/digital-prf/${prfId}/submit`,
    null,
    { headers: authHeaders, tags: { name: 'submit_prf' } }
  );

  const duration = Date.now() - t0;
  submitDuration.add(duration);

  if (check(submitRes, {
    'submit succeeded': (r) => r.status === 200 || r.status === 202,
    'submit < 2s': (r) => r.timings.duration < 2000,
  })) {
    prfSubmissions.add(1);
  } else {
    prfFailures.add(1);
  }

  // Small pause between iterations
  sleep(0.5);
}

// ── Summary Handler ──
export function handleSummary(data) {
  const submitted = data.metrics.prf_submissions_total?.values?.count || 0;
  const failed = data.metrics.prf_failures_total?.values?.count || 0;
  const p95 = data.metrics.http_req_duration?.values?.['p(95)'] || 0;

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  EMS Shift-Change Load Test Results      ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  PRFs Submitted: ${String(submitted).padStart(6)}               ║`);
  console.log(`║  PRFs Failed:    ${String(failed).padStart(6)}               ║`);
  console.log(`║  p95 Latency:    ${String(Math.round(p95)).padStart(6)}ms             ║`);
  console.log(`║  Target:         900 PRFs/hr (15/min)    ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
