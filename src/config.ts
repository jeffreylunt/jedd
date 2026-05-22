import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

/** Normalize a phone to E.164-ish (+<digits>). Bare 10-digit US numbers get +1. */
export function normalizePhone(raw: string): string {
  const cleaned = (raw || '').replace(/[^\d+]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 10) return '+1' + cleaned;
  return '+' + cleaned;
}

function parsePhoneList(raw: string): string[] {
  return (raw || '').split(',').map(p => normalizePhone(p.trim())).filter(Boolean);
}

export const config = {
  sonarr: {
    // Full base URL to your Sonarr API v3 root, e.g. http://10.0.0.10:8989/sonarr/api/v3
    // (or http://host.docker.internal:8989/... from a container on macOS).
    baseUrl: (process.env.SONARR_URL || 'http://localhost:8989/api/v3').replace(/\/$/, ''),
    apiKey: requireEnv('SONARR_API_KEY'),
    // Quality profile id + root folder are SPECIFIC TO YOUR Sonarr instance — look them up in
    // Sonarr (Settings > Profiles, and the path under Settings > Media Management). Defaults are
    // placeholders; set SONARR_QUALITY_PROFILE_ID and SONARR_ROOT_FOLDER for your install.
    qualityProfileId: parseInt(process.env.SONARR_QUALITY_PROFILE_ID || '1'),
    rootFolder: requireEnv('SONARR_ROOT_FOLDER'),
  },
  // Preferred audio/release language for adds. NOTE: enforcement lives in your Sonarr/Radarr
  // quality profiles as Custom Formats (a "Language: <lang>" positive CF + a "Not <lang>" negative
  // CF), NOT in this code. This value is just the documented source of truth for the preference; if
  // you change it you must rebuild those Custom Formats to match. See README.
  preferredLanguage: process.env.PREFERRED_LANGUAGE || 'English',
  radarr: {
    // Full base URL to your Radarr API v3 root, e.g. http://10.0.0.10:7878/radarr/api/v3
    baseUrl: (process.env.RADARR_URL || 'http://localhost:7878/api/v3').replace(/\/$/, ''),
    apiKey: requireEnv('RADARR_API_KEY'),
    // Specific to your Radarr instance — see the Sonarr note above.
    qualityProfileId: parseInt(process.env.RADARR_QUALITY_PROFILE_ID || '1'),
    rootFolder: requireEnv('RADARR_ROOT_FOLDER'),
  },
  bluebubbles: {
    // URL of your running BlueBubbles server (the desktop app's server URL).
    url: (process.env.BLUEBUBBLES_URL || 'http://localhost:1234').replace(/\/$/, ''),
    // Required — your BlueBubbles server password. No default (never ship an insecure default).
    password: requireEnv('BLUEBUBBLES_PASSWORD'),
    // Port the inbound webhook receiver listens on, and the host it binds to. Inside a container
    // bind 0.0.0.0 so the BlueBubbles server can POST to it; on a bare host 127.0.0.1 is fine.
    webhookPort: parseInt(process.env.BLUEBUBBLES_WEBHOOK_PORT || '18790'),
    webhookHost: process.env.BLUEBUBBLES_WEBHOOK_HOST || '127.0.0.1',
    // The URL the BlueBubbles SERVER will POST inbound messages to — it must be reachable FROM the
    // BlueBubbles server. On a bare host this is just the local bind. In a container, set
    // BLUEBUBBLES_WEBHOOK_URL to an address the BlueBubbles host can reach (e.g. the Docker host's
    // LAN IP, or use host networking). Defaults to the local bind host:port.
    get webhookUrl() {
      return process.env.BLUEBUBBLES_WEBHOOK_URL
        || `http://${config.bluebubbles.webhookHost}:${config.bluebubbles.webhookPort}/webhook`;
    },
  },
  // The Ollama LLM. `model` should be a tool-calling-capable model (default qwen2.5:7b). Change it
  // without a code edit via OLLAMA_MODEL (LOCAL_MODEL is a back-compat alias). `url` is your Ollama
  // daemon (http://host.docker.internal:11434 from a container on macOS).
  ollama: {
    url: (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, ''),
    model: process.env.OLLAMA_MODEL || process.env.LOCAL_MODEL || 'qwen2.5:7b',
  },
  // Display name / persona used in prompts and replies.
  displayName: process.env.DISPLAY_NAME || 'Jedd',
  // Access control — DEFAULT DENY. A sender is allowed ONLY if they are the OWNER_PHONE or in the
  // ALLOWED_SENDERS allowlist. Everyone else is silently ignored. With an empty allowlist and
  // ALLOW_ALL_SENDERS unset, NOBODY can use the bot until numbers are added to the config — this is
  // the secure default. Set ALLOW_ALL_SENDERS=true to open the bot to anyone who messages (spam is
  // still rate/pattern-blocked). The owner is always allowed and never spam-blocked.
  ownerPhone: normalizePhone(process.env.OWNER_PHONE || ''),
  allowedSenders: parsePhoneList(process.env.ALLOWED_SENDERS || ''),
  allowAllSenders: /^(true|1|yes)$/i.test(process.env.ALLOW_ALL_SENDERS || ''),
  dataDir: join(PROJECT_ROOT, 'data'),
} as const;

/** True if the sender is the configured owner (full access). */
export function isOwner(phone: string): boolean {
  return !!config.ownerPhone && phone === config.ownerPhone;
}

/** True if the sender may interact with the bot. DEFAULT DENY: only the owner and numbers in the
 *  ALLOWED_SENDERS allowlist are permitted. ALLOW_ALL_SENDERS=true opens it to everyone. An empty
 *  allowlist with the flag off means nobody is allowed until numbers are added — the secure default. */
export function isAllowed(phone: string): boolean {
  if (isOwner(phone)) return true;
  if (config.allowAllSenders) return true; // explicitly opened to everyone
  return config.allowedSenders.includes(phone);
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string; // ISO timestamp
}

export interface AppState {
  activeJobs: DownloadJob[];
  processedMessageIds: number[];
  blockedNumbers: string[]; // Numbers blocked for spam
  messageRates: Record<string, number[]>; // Phone -> timestamps of recent messages
  conversationHistory: Record<string, ConversationMessage[]>; // Phone -> recent messages
  lastRowid?: number; // Highest BlueBubbles rowid we've processed — used for replay on restart
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// --- State persistence ---

export interface DownloadJob {
  id: string;
  type: 'movie' | 'tv';
  title: string;
  arrId: number; // Radarr movieId or Sonarr seriesId
  seasons?: number[]; // For TV shows
  requestedBy: string; // Phone number
  requestedAt: string; // ISO timestamp
  qualityProfileId: number;
  status: 'downloading' | 'complete' | 'failed';
  nextCheckAt: string; // ISO timestamp
  checkCount: number;
  lastProgress?: number; // Last download % reported to the user (local-backend templated updates)
  notifiedStuckImport?: boolean; // true once we've told the user it downloaded-but-can't-import (no re-notify)
}

const STATE_FILE = join(PROJECT_ROOT, 'data', 'state.json');
const MAX_PROCESSED_IDS = 1000;

function defaultState(): AppState {
  return {
    activeJobs: [],
    processedMessageIds: [],
    blockedNumbers: [],
    messageRates: {},
    conversationHistory: {},
  };
}

export function loadState(): AppState {
  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true });
  }
  if (!existsSync(STATE_FILE)) {
    return defaultState();
  }
  let parsed: Partial<AppState> & Record<string, unknown>;
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8');
    parsed = JSON.parse(raw);
  } catch {
    console.error('[state] Failed to parse state file, using defaults');
    return defaultState();
  }
  // Merge with defaults so schema drift (older state files missing newer fields)
  // can't surface as runtime TypeErrors like `state.blockedNumbers.includes` on undefined.
  const base = defaultState();
  return { ...base, ...parsed } as AppState;
}

export function saveState(state: AppState): void {
  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true });
  }
  // Trim processedMessageIds to last MAX_PROCESSED_IDS
  if (state.processedMessageIds.length > MAX_PROCESSED_IDS) {
    state.processedMessageIds = state.processedMessageIds.slice(-MAX_PROCESSED_IDS);
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
