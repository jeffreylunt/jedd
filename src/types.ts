export interface IncomingMessage {
  rowid: number;
  sender: string; // Phone number like +15551234567
  text: string;
  timestamp: string; // ISO timestamp
  isFromMe: boolean;
  chatId?: number;
}

export interface SonarrSeries {
  id: number;
  title: string;
  year: number;
  tvdbId: number;
  imdbId?: string;
  overview: string;
  seasonCount: number;
  seasons: { seasonNumber: number; monitored: boolean }[];
  qualityProfileId: number;
  rootFolderPath: string;
  monitored: boolean;
  added: string;
  popularity?: number;
  // Present on /series and /series/{id} (NOT reliably on /series/lookup — there it's zeroed). Used to
  // tell a fully-downloaded series from one that's in the library but missing episodes (net #11 TV).
  statistics?: {
    seasonCount?: number;
    episodeCount?: number;       // monitored episodes that have aired (the "should have a file" set)
    episodeFileCount?: number;   // episodes that actually have a file on disk
    totalEpisodeCount?: number;
    percentOfEpisodes?: number;
    sizeOnDisk?: number;
  };
}

export interface RadarrMovie {
  id: number;
  title: string;
  year: number;
  tmdbId: number;
  imdbId?: string;
  overview: string;
  qualityProfileId: number;
  rootFolderPath: string;
  monitored: boolean;
  hasFile: boolean;
  added: string;
  popularity?: number;
  // TMDB collection this film belongs to (e.g. "Despicable Me Collection"). Present on /movie/lookup
  // results; used to resolve a whole-franchise / multi-sequel request to real members + real ids.
  collection?: { title?: string; tmdbId?: number };
}

export interface QueueItem {
  id: number;
  title: string;
  status: string;
  sizeleft: number;
  size: number;
  timeleft?: string;
}

export interface EpisodeStatus {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  hasFile: boolean;
  monitored: boolean;
}

