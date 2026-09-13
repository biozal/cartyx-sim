import { join } from 'node:path';

const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]*$/;

export function campaignDir(campaignsDir: string, campaign: string): string {
  if (!CAMPAIGN_ID.test(campaign)) {
    throw new Error(`Campaign id "${campaign}" must be lowercase letters, digits, and dashes`);
  }
  return join(campaignsDir, campaign);
}

export function sessionDir(campaignsDir: string, campaign: string, session: number): string {
  const dir = campaignDir(campaignsDir, campaign);
  if (!Number.isSafeInteger(session) || session < 1) {
    throw new Error(`Session number must be a positive integer, got ${session}`);
  }
  return join(dir, 'sessions', String(session).padStart(3, '0'));
}

export function sessionEventsPath(campaignsDir: string, campaign: string, session: number): string {
  return join(sessionDir(campaignsDir, campaign, session), 'events.jsonl');
}
