/**
 * Consent gate — gates attribution + analytics calls so SDKs comply with
 * DPDP/GDPR. OTP send/verify still works without consent (it's a service
 * action), but attribution/conversion events are dropped silently when
 * consent is false.
 */

let granted = false;

export function set(value: boolean): void {
  granted = !!value;
}

export function get(): boolean {
  return granted;
}

export function require(): boolean {
  return granted;
}

/** Test-only. */
export function __reset(): void {
  granted = false;
}
