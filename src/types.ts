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

