/**
 * DPDP / GDPR consent gate for attribution and conversion tracking.
 *
 * Same behaviour as the Flutter SDK: the choice is persisted, calls made
 * without consent are queued until granted, and revoking drops the queue and
 * stored attribution data. OTP send/verify are not gated.
 */

import * as storage from './storage';

export const CONSENT_KEY = 'qa.consent_granted';

/** Attribution data removed from the device when consent is revoked. */
const ATTRIBUTION_KEYS = ['qa.qa_clid', 'qa.campaign_id', 'qa.fingerprint_anchor', 'qa.attribution'];

type Runner = () => Promise<unknown>;

let granted = false;
let queue: Runner[] = [];

/** Load the saved choice; `initial` applies only when nothing was saved. */
export async function hydrate(initial = false): Promise<void> {
  granted = initial;
  try {
    const stored = await storage.getItem(CONSENT_KEY);
    if (stored === 'true' || stored === 'false') granted = stored === 'true';
  } catch {
    /* no storage; keep the initial value */
  }
}

/**
 * Record the user's choice. `get()` reflects it immediately; the returned
 * promise settles once it is saved and any queued work has run.
 */
export async function set(value: boolean): Promise<boolean> {
  const next = !!value;
  const previous = granted;
  granted = next;
  try {
    await storage.setItem(CONSENT_KEY, String(next));
  } catch {
    /* no storage; the in-memory choice still applies */
  }

  if (next && !previous) {
    const replay = queue;
    queue = [];
    for (const runner of replay) {
      try {
        await runner();
      } catch {
        /* analytics must never crash the host */
      }
    }
  } else if (!next && previous) {
    queue = [];
    for (const key of ATTRIBUTION_KEYS) {
      try {
        await storage.removeItem(key);
      } catch {
        /* noop */
      }
    }
  }
  return next;
}

export function get(): boolean {
  return granted;
}

/** Run now if consent is granted, otherwise queue until it is. */
export async function run(runner: Runner): Promise<void> {
  if (granted) {
    await runner();
  } else {
    queue.push(runner);
  }
}

/** Number of queued calls waiting for consent. */
export function pendingCount(): number {
  return queue.length;
}

/** Drop queued work without changing the choice. Used by QuickAuth.reset(). */
export function clearQueue(): void {
  queue = [];
}

export function __reset(): void {
  granted = false;
  queue = [];
}
