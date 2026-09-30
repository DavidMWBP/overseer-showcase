import webpush from 'web-push';
import type { Db } from '../db/db';
import { log } from '../util/log';

/** What a notification carries; `url` is the hash the tap opens (`#chat`, `#review`, `#board`). */
export interface PushMessage { title: string; body: string; url: string }
/** One device's outcome of a send; `body` is the first 200 characters of the service's answer. */
export interface PushResult { endpoint_host: string; ok: boolean; statusCode?: number; body?: string; dropped?: boolean }
export interface PushSubscriptionJson { endpoint: string; keys: { p256dh: string; auth: string } }
/** `sendNotification` of web-push; injectable so tests do not touch the network. Throws with `statusCode` and `body` of the service's answer. */
export type PushSender = (sub: PushSubscriptionJson, payload: string, vapid: { subject: string; publicKey: string; privateKey: string }) => Promise<unknown>;

const defaultSender: PushSender = (sub, payload, vapidDetails) => webpush.sendNotification(sub, payload, { vapidDetails, TTL: 60 * 60 });

/**
 * The VAPID subject identifies the sender to the push service. Apple's answers 403 BadJwtToken to a `mailto:` on `localhost` and to an
 * `https:` URL it cannot resolve, while Google accepts anything (2026-09-14: the phone got nothing, the desktop did); a well-formed
 * address on a real domain passes. `OVERSEER_PUSH_SUBJECT` overrides it.
 */
export const DEFAULT_PUSH_SUBJECT = 'mailto:overseer@example.com';

/**
 * Web push to the browsers that subscribed in Setup. The VAPID key pair is generated once and kept in `settings` (`vapid`), so
 * subscriptions survive restarts; a send the service answers with a dead-subscription status (`isDeadSubscription`) drops that row.
 * `notify` never throws: a failure is a log line and a result entry, so callers may fire and forget (every flow does) or await
 * the per-device results (the test notification).
 */
export class Push {
  constructor(private db: Db, private send: PushSender = defaultSender, private subject: string = process.env.OVERSEER_PUSH_SUBJECT || DEFAULT_PUSH_SUBJECT) {}

  /** The public key the browser subscribes with (base64url, as PushManager expects). Generated on first use. */
  publicKey(): string { return this.vapid().publicKey; }

  private vapid(): { subject: string; publicKey: string; privateKey: string } {
    let keys = this.db.settings.get('vapid') as { publicKey: string; privateKey: string } | undefined;
    if (!keys) { keys = webpush.generateVAPIDKeys(); this.db.settings.set('vapid', keys); }
    return { subject: this.subject, ...keys };
  }

  subscribe(sub: PushSubscriptionJson): void { this.db.push.upsert(sub.endpoint, JSON.stringify(sub)); }
  unsubscribe(endpoint: string): void { this.db.push.delete(endpoint); }
  count(): number { return this.db.push.list().length; }

  /** Sends to every subscription; resolves when every send settled with one result per device. */
  async notify(m: PushMessage): Promise<PushResult[]> {
    const subs = this.db.push.list();
    if (subs.length === 0) return [];
    const vapid = this.vapid();
    const payload = JSON.stringify(m);
    return Promise.all(subs.map(async (row): Promise<PushResult> => {
      const endpoint_host = new URL(row.endpoint).host;
      try {
        await this.send(JSON.parse(row.subscription) as PushSubscriptionJson, payload, vapid);
        return { endpoint_host, ok: true };
      } catch (err) {
        const { statusCode, body: rawBody } = err as { statusCode?: number; body?: string };
        const body = String(rawBody ?? (err instanceof Error ? err.message : err)).slice(0, 200);
        // The endpoint is a capability URL: the host and the tail of the path identify the row without disclosing it.
        const where = { host: endpoint_host, path_tail: new URL(row.endpoint).pathname.slice(-12), created_at: row.created_at };
        if (isDeadSubscription(statusCode, body)) {
          this.db.push.delete(row.endpoint);
          log.info('push: dropped a dead subscription', { ...where, statusCode, body });
          return { endpoint_host, ok: false, statusCode, body, dropped: true };
        }
        log.error('push: send failed', { ...where, statusCode, body });
        if (err instanceof Error) log.debug('push: send failed', { ...where, stack: err.stack });
        return { endpoint_host, ok: false, statusCode, body };
      }
    }));
  }
}

/**
 * A push service says a subscription is dead with 404 or 410 (RFC 8030); Mozilla autopush's "Invalid subscription" (errno 106)
 * is one of those 410s. Apple also answers 403 for a subscription that no longer belongs to this VAPID key; only a body that
 * names such a problem counts, because 401/403 is also what a service answers to a sender-side problem, which must keep the row:
 * Apple's `BadJwtToken` (bad VAPID subject, see DEFAULT_PUSH_SUBJECT) and `ExpiredProviderToken` (an expired sender JWT, e.g.
 * clock skew), and Mozilla's 401, whose body always carries the "Unauthorized" status string and which its docs file under
 * Bad Authorization (the sender's own VAPID header or TTL). Matched, case-insensitive: `VapidPkHashMismatch` (Apple:
 * subscription made with another key), `InvalidTokenFormat` and `TopicDisallowed` (Apple: the key or the token no longer fit
 * this endpoint), `unsubscribed` and `subscription expired` (FCM/legacy bodies for a browser that left; FCM also answers
 * "NotRegistered" as a 404). Bare `expired` is NOT matched so that ExpiredProviderToken keeps the row.
 */
const DEAD_BODY = /VapidPkHashMismatch|InvalidTokenFormat|TopicDisallowed|unsubscribed|subscription expired/i;
export function isDeadSubscription(statusCode: number | undefined, body: string): boolean {
  if (statusCode === 404 || statusCode === 410) return true;
  return (statusCode === 401 || statusCode === 403) && DEAD_BODY.test(body);
}
