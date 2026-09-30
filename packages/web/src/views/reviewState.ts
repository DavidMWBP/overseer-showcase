/** What an outage does to Merge / Reject / Abandon: they are disabled, so a click is dropped, not queued. */
export const OFFLINE_ACTIONS = 'The daemon is unreachable: nothing is sent and nothing is queued. Your note is kept; press again once it is back.';

/** The rejection note is kept per batch (or v1 bead) for this browser session. */
const draftKey = (id: string) => `overseer.reviewNote.${id}`;
export const readDraft = (id: string | null): string => { if (!id) return ''; try { return sessionStorage.getItem(draftKey(id)) ?? ''; } catch { return ''; } };
export const writeDraft = (id: string | null, text: string): void => { if (!id) return; try { if (text) sessionStorage.setItem(draftKey(id), text); else sessionStorage.removeItem(draftKey(id)); } catch { /* storage unavailable */ } };
