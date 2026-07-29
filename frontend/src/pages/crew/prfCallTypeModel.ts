/**
 * Call types and billing types — the tables that decide which payer block a PRF
 * captures, and therefore how the claim is billed.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * These lived as `const`s inside DigitalPRFForm.tsx, which no test can import
 * (a non-component export there disables React Fast Refresh). So the test suite
 * hand-copied them — and then drifted:
 *
 *   conditionalFields.test.ts asserted on a billing type 'WCA' that has never
 *   existed in BILLING_TYPE_OPTS, on a field `mechanism_detail` (the real key is
 *   `mechanism_other`), on `raf_claim_number` (the real keys are
 *   raf_police_case_number / raf_accident_date / raf_oar_report_pdf), and on a
 *   mechanism 'Medical' (the real option is 'Medical Emergency').
 *
 * All of it passed, because the test was asserting against its own copy. A
 * green suite that describes a product you do not have is worse than no suite:
 * it answers "did I break anything?" with a confident, meaningless yes.
 *
 * Importing from here makes drift impossible — a rename breaks the test.
 */

export const CALL_TYPE_OPTS = [
  'PRIMARY', 'IHT', 'RHT', 'WCA_IOD', 'COURTESY', 'RESUS', 'DOD',
] as const;
export type CallType = typeof CALL_TYPE_OPTS[number];

export const BILLING_TYPE_OPTS = [
  'MED AID', 'RAF', 'PVT', 'CALL OUT FEE',
] as const;
export type BillingType = typeof BILLING_TYPE_OPTS[number];

/** Display label for a call type. 'IHT' is shown as 'IFT/IHT' on the form. */
export const CALL_TYPE_LABELS: Record<CallType, string> = {
  PRIMARY: 'PRIMARY',
  IHT: 'IFT/IHT',
  RHT: 'RHT',
  WCA_IOD: 'WCA / IOD',
  COURTESY: 'COURTESY',
  RESUS: 'RESUS',
  DOD: 'DOD',
};

/**
 * Which billing types the picker offers for a given call type.
 *
 *  - CALL OUT FEE is never offered in the picker (it is set elsewhere), so it
 *    is filtered out of every arm despite being a member of BILLING_TYPE_OPTS.
 *  - DOD drops RAF: there is no third-party road-accident claim for a patient
 *    declared dead at scene.
 *  - RESUS is restricted to MED AID and PVT.
 *  - COURTESY captures no payer block at all — it is a non-billable transfer.
 */
export function billingOptsFor(callType: string | undefined | null): BillingType[] {
  const base = BILLING_TYPE_OPTS.filter(o => o !== 'CALL OUT FEE') as BillingType[];
  if (callType === 'COURTESY') return [];
  if (callType === 'DOD') return base.filter(o => o !== 'RAF');
  if (callType === 'RESUS') return base.filter(o => o === 'MED AID' || o === 'PVT');
  return base;
}

/** True when the call type captures no payer information at all. */
export function isNonBillable(callType: string | undefined | null): boolean {
  return callType === 'COURTESY';
}

/**
 * True when the patient was never conveyed, so destination, handover and
 * valuables rows — and the Depart/Arrival odometer rows — do not apply.
 * RHT = the patient refused transport; DOD = deceased at scene.
 */
export function isNoTransport(callType: string | undefined | null): boolean {
  return callType === 'RHT' || callType === 'DOD';
}
