import { config } from './config.js';
import type { SonarrSeries, RadarrMovie, QueueItem, EpisodeStatus } from './types.js';

// --- Generic HTTP helpers ---

async function sonarrGet<T>(path: string): Promise<T> {
  const url = `${config.sonarr.baseUrl}${path}`;
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}apikey=${config.sonarr.apiKey}`);
  if (!res.ok) throw new Error(`Sonarr GET ${path}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function sonarrPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${config.sonarr.baseUrl}${path}?apikey=${config.sonarr.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sonarr POST ${path}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

async function radarrGet<T>(path: string): Promise<T> {
  const url = `${config.radarr.baseUrl}${path}`;
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}apikey=${config.radarr.apiKey}`);
  if (!res.ok) throw new Error(`Radarr GET ${path}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function radarrPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${config.radarr.baseUrl}${path}?apikey=${config.radarr.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Radarr POST ${path}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

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
