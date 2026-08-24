import type { Config } from './config.js';

export interface JellyfinResponse {
  ok: boolean;
  status: number;
  /** Parsed JSON body, or undefined when the body was not JSON. */
  body?: unknown;
  error?: string;
}

/**
 * One place that talks to Jellyfin. Never throws — every failure comes back as
 * a value with `ok: false`, so a caller cannot mistake a network error for an
 * empty result.
 */
export async function jellyfinGet(
  config: Config,
  path: string,
  timeoutMs = 15_000,
): Promise<JellyfinResponse> {
  if (!config.jellyfin.apiKey) {
    return { ok: false, status: 0, error: 'JELLYFIN_API_KEY is not configured' };
  }
  const url = `${config.jellyfin.baseUrl.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'X-Emby-Token': config.jellyfin.apiKey, Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: res.status, error: `response was not JSON: ${text.slice(0, 300)}` };
    }
  } catch (e) {
    return { ok: false, status: 0, error: `request failed: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
