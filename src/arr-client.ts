import { config } from './config.js';
import { jlog, truncate } from './logger.js';
import type { SonarrSeries, RadarrMovie, QueueItem, EpisodeStatus } from './types.js';

// --- Generic HTTP helpers ---
//
// Every Sonarr/Radarr call is logged at the HTTP layer (service, method, path, status, ms, and a
// short shape of the response — array length or the returned id) so a failed interaction can be
// reconstructed from logs ALONE: you can see the exact lookup candidates returned, the add request
// body, the HTTP status, and the returned arr id. The api key is appended to the url internally and
// is NEVER logged (we log the key-free `path`; jlog also redacts apikey= as a backstop). On error,
// the status + response body are logged before the throw so a 4xx/5xx/redirect is never silent.

// Compact, decision-relevant shape of an arr response for the log (full bodies can be huge).
function shape(data: unknown): unknown {
  if (Array.isArray(data)) {
    return {
      count: data.length,
      sample: data.slice(0, 5).map((d: any) => ({
        id: d?.id, title: d?.title, year: d?.year,
        tmdbId: d?.tmdbId, tvdbId: d?.tvdbId, hasFile: d?.hasFile,
      })),
    };
  }
  if (data && typeof data === 'object') {
    const d = data as any;
    return { id: d.id, title: d.title, year: d.year, tmdbId: d.tmdbId, tvdbId: d.tvdbId, hasFile: d.hasFile };
  }
  return data;
}

async function arrFetch<T>(service: 'sonarr' | 'radarr', method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const cfg = service === 'sonarr' ? config.sonarr : config.radarr;
  const sep = path.includes('?') ? '&' : '?';
  const url = `${cfg.baseUrl}${path}${sep}apikey=${cfg.apiKey}`;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, method === 'POST'
      ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method });
  } catch (err) {
    jlog('arr.http', { service, method, path, ok: false, error: String(err), ms: Date.now() - started });
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    jlog('arr.http', { service, method, path, status: res.status, ok: false, ms: Date.now() - started, error: truncate(text, 500) });
    throw new Error(`${service} ${method} ${path}: ${res.status} ${res.statusText} ${text}`.trim());
  }
  const data = (await res.json()) as T;
  jlog('arr.http', {
    service, method, path, status: res.status, ok: true, ms: Date.now() - started,
    ...(method === 'POST' ? { reqBody: body } : {}),
    resp: shape(data),
  });
  return data;
}

const sonarrGet = <T>(path: string) => arrFetch<T>('sonarr', 'GET', path);
const sonarrPost = <T>(path: string, body: unknown) => arrFetch<T>('sonarr', 'POST', path, body);
const radarrGet = <T>(path: string) => arrFetch<T>('radarr', 'GET', path);
const radarrPost = <T>(path: string, body: unknown) => arrFetch<T>('radarr', 'POST', path, body);

// --- Sonarr (TV Shows) ---

export async function searchSonarr(term: string): Promise<SonarrSeries[]> {
  return sonarrGet<SonarrSeries[]>(`/series/lookup?term=${encodeURIComponent(term)}`);
}

export async function getSonarrSeries(seriesId: number): Promise<SonarrSeries> {
  return sonarrGet<SonarrSeries>(`/series/${seriesId}`);
}

export async function addSonarrSeries(
  lookupResult: SonarrSeries,
  monitoredSeasons: number[] | 'all'
): Promise<SonarrSeries> {
  // Set up season monitoring
  const seasons = lookupResult.seasons.map((s) => ({
    ...s,
    monitored: monitoredSeasons === 'all' ? s.seasonNumber > 0 : monitoredSeasons.includes(s.seasonNumber),
  }));

  // Future-season monitoring: when the user wants the WHOLE show ("all"), monitor new seasons as
  // they air so a continuing series keeps grabbing future episodes automatically. When they picked
  // SPECIFIC seasons, set 'none' so we don't silently pull seasons they didn't ask for. Sonarr
  // defaults this to 'all' when omitted — making it explicit keeps a specific-season add scoped.
  const monitorNewItems = monitoredSeasons === 'all' ? 'all' : 'none';

  const body = {
    title: lookupResult.title,
    tvdbId: lookupResult.tvdbId,
    qualityProfileId: config.sonarr.qualityProfileId,
    rootFolderPath: config.sonarr.rootFolder,
    monitored: true,
    monitorNewItems,
    seasons,
    seasonFolder: true,
    addOptions: {
      searchForMissingEpisodes: true,
    },
  };

  return sonarrPost<SonarrSeries>('/series', body);
}

export async function triggerSeriesSearch(seriesId: number): Promise<void> {
  await sonarrPost('/command', { name: 'SeriesSearch', seriesId });
}

export async function triggerMissingEpisodeSearch(seriesId: number, seasonNumber?: number): Promise<void> {
  const body: Record<string, unknown> = { name: 'MissingEpisodeSearch', seriesId };
  if (seasonNumber !== undefined) body.seasonNumber = seasonNumber;
  await sonarrPost('/command', body);
}

export async function getSonarrQueue(seriesId: number): Promise<QueueItem[]> {
  const result = await sonarrGet<{ records: QueueItem[] }>(`/queue?seriesId=${seriesId}&pageSize=100`);
  return result.records || [];
}

export async function getAllEpisodeStatus(seriesId: number): Promise<EpisodeStatus[]> {
  return sonarrGet<EpisodeStatus[]>(`/episode?seriesId=${seriesId}`);
}

export async function checkSeriesExists(tvdbId: number): Promise<SonarrSeries | null> {
  try {
    const allSeries = await sonarrGet<SonarrSeries[]>('/series');
    return allSeries.find((s) => s.tvdbId === tvdbId) || null;
  } catch {
    return null;
  }
}

// --- Radarr (Movies) ---

export async function searchRadarr(term: string): Promise<RadarrMovie[]> {
  return radarrGet<RadarrMovie[]>(`/movie/lookup?term=${encodeURIComponent(term)}`);
}

export async function getRadarrMovie(movieId: number): Promise<RadarrMovie> {
  return radarrGet<RadarrMovie>(`/movie/${movieId}`);
}

export async function addRadarrMovie(lookupResult: RadarrMovie): Promise<RadarrMovie> {
  const body = {
    title: lookupResult.title,
    tmdbId: lookupResult.tmdbId,
    qualityProfileId: config.radarr.qualityProfileId,
    rootFolderPath: config.radarr.rootFolder,
    monitored: true,
    addOptions: {
      searchForMovie: true,
    },
  };

  return radarrPost<RadarrMovie>('/movie', body);
}

export async function triggerMovieSearch(movieId: number): Promise<void> {
  await radarrPost('/command', { name: 'MoviesSearch', movieIds: [movieId] });
}

export async function getRadarrQueue(movieId: number): Promise<QueueItem[]> {
  const result = await radarrGet<{ records: QueueItem[] }>(`/queue?movieId=${movieId}&pageSize=100`);
  return result.records || [];
}

export async function checkMovieExists(tmdbId: number): Promise<RadarrMovie | null> {
  try {
    const allMovies = await radarrGet<RadarrMovie[]>('/movie');
    return allMovies.find((m) => m.tmdbId === tmdbId) || null;
  } catch {
    return null;
  }
}
