// Integration tests for runLocalSession's recovery LOOP, with global fetch stubbed so both the
// Ollama turns AND the Radarr/Sonarr calls are scripted and deterministic (no live model/server).
// Verifies safety-net #4: a bad/hallucinated-id add (no prior search) that the model then PUNTS on
// ("let me search again") is forced to actually search + re-add in the same turn — and the
// already-in-library path reports cleanly with no dangling promise and no false add.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SONARR_API_KEY ??= 'test';
process.env.RADARR_API_KEY ??= 'test';
process.env.SONARR_ROOT_FOLDER ??= '/tv';
process.env.RADARR_ROOT_FOLDER ??= '/movies';
process.env.BLUEBUBBLES_PASSWORD ??= 'test';
process.env.OLLAMA_MODEL ??= 'test-model';

const { runLocalSession } = await import('./local-backend.js');

// --- scripted Ollama turn queue + Radarr fixtures -------------------------------------------------
type Turn = { content?: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> };

function installFetchStub(turns: Turn[], radarr: {
  lookupByTerm?: Record<string, any[]>;        // term -> lookup results
  lookupByTmdb?: Record<number, any[]>;        // tmdbId -> `tmdb:N` lookup results
  library?: any[];                              // GET /movie (already-in-library check)
  onAdd?: (body: any) => any;                   // POST /movie -> added movie
}) {
  const realFetch = globalThis.fetch;
  let turnIdx = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    calls.push(`${init?.method || 'GET'} ${u.split('?')[0]}`);
    // Ollama chat
    if (u.includes('/api/chat')) {
      const turn = turns[Math.min(turnIdx, turns.length - 1)];
      turnIdx++;
      return { ok: true, json: async () => ({ message: turn }) } as any;
    }
    // Radarr library list
    if (/\/movie\?/.test(u) || /\/movie$/.test(u.split('?')[0])) {
      if ((init?.method || 'GET') === 'GET' && !/\/movie\/\d/.test(u)) {
        return { ok: true, json: async () => radarr.library || [] } as any;
      }
    }
    // Radarr lookup
    if (u.includes('/movie/lookup')) {
      const m = decodeURIComponent(u).match(/term=([^&]+)/);
      const term = m ? m[1] : '';
      if (term.startsWith('tmdb:')) {
        const id = Number(term.slice(5));
        return { ok: true, json: async () => (radarr.lookupByTmdb?.[id] || []) } as any;
      }
      return { ok: true, json: async () => (radarr.lookupByTerm?.[term] || []) } as any;
    }
    // Radarr add (POST /movie)
    if (/\/movie(\?|$)/.test(u) && (init?.method) === 'POST') {
      const body = JSON.parse(init.body);
      return { ok: true, json: async () => (radarr.onAdd ? radarr.onAdd(body) : { id: 999, ...body }) } as any;
    }
    // Radarr queue (status checks) — empty
    if (u.includes('/queue')) return { ok: true, json: async () => ({ records: [] }) } as any;
    return { ok: true, json: async () => ({}) } as any;
  }) as any;
  return { restore: () => { globalThis.fetch = realFetch; }, calls: () => calls };
}

// Sonarr-aware stub for the multi-turn TV (Severance) path: search_tv -> add_tv with seasons.
function installSonarrFetchStub(turns: Turn[], sonarr: {
  lookupByTerm?: Record<string, any[]>;       // term -> /series/lookup results
  lookupByTvdb?: Record<number, any[]>;       // tvdbId -> `tvdb:N` lookup results
  library?: any[];                            // GET /series (already-in-library check)
  seriesById?: Record<number, any>;           // GET /series/{id} (episode-completeness stats)
  onAdd?: (body: any) => any;                 // POST /series -> added series
}) {
  const realFetch = globalThis.fetch;
  let turnIdx = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    const method = init?.method || 'GET';
    calls.push(`${method} ${u.split('?')[0]}`);
    if (u.includes('/api/chat')) {
      const turn = turns[Math.min(turnIdx, turns.length - 1)];
      turnIdx++;
      return { ok: true, json: async () => ({ message: turn }) } as any;
    }
    // Sonarr lookup (/series/lookup?term=...)
    if (u.includes('/series/lookup')) {
      const m = decodeURIComponent(u).match(/term=([^&]+)/);
      const term = m ? m[1] : '';
      if (term.startsWith('tvdb:')) {
        const id = Number(term.slice(5));
        return { ok: true, json: async () => (sonarr.lookupByTvdb?.[id] || []) } as any;
      }
      return { ok: true, json: async () => (sonarr.lookupByTerm?.[term] || []) } as any;
    }
    // Sonarr single series (GET /series/{id}) — carries episode-completeness statistics
    if (method === 'GET' && /\/series\/(\d+)/.test(u) && !u.includes('/lookup')) {
      const id = Number(u.match(/\/series\/(\d+)/)![1]);
      return { ok: true, json: async () => (sonarr.seriesById?.[id] || {}) } as any;
    }
    // Sonarr library list (GET /series, not /series/{id} or /series/lookup)
    if (/\/series(\?|$)/.test(u.split('?')[0] + (u.includes('?') ? '?' : '')) && method === 'GET' && !/\/series\/\d/.test(u)) {
      return { ok: true, json: async () => sonarr.library || [] } as any;
    }
    // Sonarr add (POST /series)
    if (/\/series(\?|$)/.test(u) && method === 'POST') {
      const body = JSON.parse(init.body);
      return { ok: true, json: async () => (sonarr.onAdd ? sonarr.onAdd(body) : { id: 777, ...body }) } as any;
    }
    if (u.includes('/queue')) return { ok: true, json: async () => ({ records: [] }) } as any;
    return { ok: true, json: async () => ({}) } as any;
  }) as any;
  return { restore: () => { globalThis.fetch = realFetch; }, calls: () => calls };
}

const tc = (name: string, args: unknown) => ({ tool_calls: [{ function: { name, arguments: args } }] });

test('safety-net #4: bad-id add then punt → forced search → real add (no dangling promise)', async () => {
  // Turn 1: model hallucinates add_movie with a bad id, no prior search.
  // Turn 2: model PUNTS — "let me search again..." (no tool call). Net #4 must fire.
  // Turn 3 (after forcing turn): model searches.
  // Turn 4: model adds with the correct id from results.
  const turns: Turn[] = [
    tc('add_movie', { title: 'Oppenheimer', tmdb_id: 12345 }),         // bad id
    { content: 'I couldn\'t find Oppenheimer using that ID. Let me run the search again to get it.' }, // punt
    tc('search_movie', { query: 'Oppenheimer' }),                       // forced search
    tc('add_movie', { title: 'Oppenheimer', tmdb_id: 872585 }),         // correct add
    { content: 'Done — Oppenheimer is downloading now.' },
  ];
  const stub = installFetchStub(turns, {
    library: [],                                              // not in library
    lookupByTmdb: {
      12345: [],                                              // bad id resolves to nothing
      872585: [{ tmdbId: 872585, title: 'Oppenheimer', year: 2023 }],
    },
    lookupByTerm: { Oppenheimer: [{ tmdbId: 872585, title: 'Oppenheimer', year: 2023, id: 0 }] },
    onAdd: (b) => ({ id: 360, title: b.title, tmdbId: b.tmdbId, year: 2023 }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you add Oppenheimer?', []);
    assert.ok(r.job, 'should have completed a real add after recovery');
    assert.equal(r.job!.arrId, 360);
    assert.match(r.job!.title, /Oppenheimer/);
    const calls = stub.calls();
    assert.ok(calls.some(c => c.includes('/movie/lookup')), 'a search/lookup must have happened');
  } finally {
    stub.restore();
  }
});

test('already-in-library: add of an existing movie reports cleanly, no false add, no dangling promise', async () => {
  // Model calls add_movie with the CORRECT id, but the movie is already in the library.
  const turns: Turn[] = [
    tc('add_movie', { title: 'Oppenheimer', tmdb_id: 872585 }),
    { content: 'Oppenheimer (2023) is already in your library — you\'re all set!' },
  ];
  const stub = installFetchStub(turns, {
    library: [{ id: 360, tmdbId: 872585, title: 'Oppenheimer', year: 2023, hasFile: true }], // already present
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you add Oppenheimer?', []);
    assert.equal(r.job, undefined, 'must NOT report a job for an already-in-library title');
    assert.match(r.response, /already in your library/i);
  } finally {
    stub.restore();
  }
});

test('in-library but no FILE: "get Hook" → net #11 triggers a MoviesSearch and reports downloading, not "already in your library"', async () => {
  // Hook is in the library (id>0) but hasFile=false — it was added/requested earlier but never
  // downloaded or imported (the live 2026-05-24 case). The model lists/asks instead of saying it's
  // there; net #11 must detect the MISSING FILE, trigger a fresh search, and tell the user it's
  // grabbing it now — NOT the misleading "already in your library" (Jeff can't watch a 0-byte movie).
  // Turn 2 is the REAL live reply: the model only sees in_library:true and parrots "already in your
  // library" — the net must OVERRIDE that because the file is actually missing.
  const turns: Turn[] = [
    tc('search_movie', { query: 'Hook' }),
    { content: 'Hook (1991) is already in your library.' },
  ];
  const stub = installFetchStub(turns, {
    lookupByTerm: { Hook: [{ id: 512, tmdbId: 879, title: 'Hook', year: 1991, hasFile: false }] },
    library: [{ id: 512, tmdbId: 879, title: 'Hook', year: 1991, hasFile: false }],
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you get hook?', []);
    // Must correct the misleading "all set" framing — tell them it's NOT downloaded and is grabbing now.
    assert.match(r.response, /hasn'?t downloaded yet/i, 'must tell the user the file is missing');
    assert.match(r.response, /grabbing it now/i, 'must say it is fetching the file');
    assert.ok(r.job, 'should register a follow-up job so the scheduler reports when it lands');
    assert.equal(r.job!.arrId, 512);
    const calls = stub.calls();
    assert.ok(calls.some(c => c.startsWith('POST') && c.includes('/command')), 'a MoviesSearch command must be POSTed');
  } finally {
    stub.restore();
  }
});

test('in-library WITH file: "get Oppenheimer" → still reports already-in-library (no needless search)', async () => {
  // Guard the happy path: a movie that's in the library AND has a file must keep the clean
  // "already in your library" reply and must NOT trigger a redundant search or register a job.
  const turns: Turn[] = [
    tc('search_movie', { query: 'Oppenheimer' }),
    { content: 'I found Oppenheimer (2023). Which one?' },
  ];
  const stub = installFetchStub(turns, {
    lookupByTerm: { Oppenheimer: [{ id: 360, tmdbId: 872585, title: 'Oppenheimer', year: 2023, hasFile: true }] },
    library: [{ id: 360, tmdbId: 872585, title: 'Oppenheimer', year: 2023, hasFile: true }],
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you get Oppenheimer?', []);
    assert.match(r.response, /already in your library/i);
    assert.equal(r.job, undefined, 'no follow-up job for an already-downloaded movie');
    const calls = stub.calls();
    assert.ok(!calls.some(c => c.startsWith('POST') && c.includes('/command')), 'must NOT trigger a search when the file is present');
  } finally {
    stub.restore();
  }
});

test('in-library TV but INCOMPLETE: "get Andor" → net #11 triggers SeriesSearch + tv job + "some episodes haven\'t downloaded"', async () => {
  // Andor is in the library (id 183) but missing an episode: episodeFileCount(23) < episodeCount(24).
  // The /series/lookup stats are zeroed, so the net must fetch /series/{id} for real counts. The
  // model parrots "already in your library" — the net must OVERRIDE it because episodes are missing.
  const turns: Turn[] = [
    tc('search_tv', { query: 'Andor' }),
    { content: 'Andor (2022) is already in your library.' },
  ];
  const stub = installSonarrFetchStub(turns, {
    lookupByTerm: { Andor: [{ id: 183, tvdbId: 393189, title: 'Andor', year: 2022, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }] }] },
    seriesById: { 183: { id: 183, title: 'Andor', year: 2022, statistics: { episodeCount: 24, episodeFileCount: 23 } } },
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you get Andor?', []);
    assert.match(r.response, /some episodes haven'?t downloaded yet/i, 'must tell the user episodes are missing');
    assert.match(r.response, /grabbing them now/i, 'must say it is fetching the episodes');
    assert.ok(r.job, 'should register a follow-up job');
    assert.equal(r.job!.arrId, 183);
    assert.equal(r.job!.type, 'tv');
    const calls = stub.calls();
    assert.ok(calls.some(c => c.startsWith('POST') && c.includes('/command')), 'a SeriesSearch command must be POSTed');
  } finally {
    stub.restore();
  }
});

test('in-library TV COMPLETE: "get Andor" → clean already-in-library reply, NO redundant search', async () => {
  // Fully complete series: episodeFileCount(24) === episodeCount(24). Keep the clean reply, no search.
  const turns: Turn[] = [
    tc('search_tv', { query: 'Andor' }),
    { content: 'I found Andor (2022). Which one did you mean?' },
  ];
  const stub = installSonarrFetchStub(turns, {
    lookupByTerm: { Andor: [{ id: 183, tvdbId: 393189, title: 'Andor', year: 2022, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }] }] },
    seriesById: { 183: { id: 183, title: 'Andor', year: 2022, statistics: { episodeCount: 24, episodeFileCount: 24 } } },
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you get Andor?', []);
    assert.match(r.response, /already in your library/i);
    assert.equal(r.job, undefined, 'no follow-up job for a complete series');
    const calls = stub.calls();
    assert.ok(!calls.some(c => c.startsWith('POST') && c.includes('/command')), 'must NOT trigger a search for a complete series');
  } finally {
    stub.restore();
  }
});

// --- multi-turn Severance: "which seasons?" -> "just season 1" -> bad-id add_tv -> forced search ---

const severanceHistory = [
  { role: 'user', text: 'Can you add severance?', timestamp: '' },
  { role: 'assistant', text: 'I found Severance. It has 4 seasons. Would you like to add specific seasons?', timestamp: '' },
];

const severanceLookup = [{
  tvdbId: 371980, title: 'Severance', year: 2022,
  seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }, { seasonNumber: 4 }],
}];

test('self-healing add_tv: bad tvdb_id on first call resolves by title and adds directly (no recovery dance)', async () => {
  // The live qwen2.5:7b shape (2026-05-22): "just season 1" → model emits add_tv with a FABRICATED
  // tvdb_id (it does this even right after a search returned the real one). The OLD path failed the
  // add and leaned on a fragile multi-hop bad-id recovery (net #4/#7) that a mid-recovery 503 or a
  // re-mangled season array could drop. Now add_tv SELF-HEALS: a bad/unresolved id with a title
  // present is resolved by a title search, taking the real id, and the add succeeds on the first
  // call. No fabricated id reaches Sonarr; no dangling stall.
  const turns: Turn[] = [
    tc('add_tv', { tvdb_id: 329865, title: 'Severance', seasons: [1] }),  // hallucinated id, real title
    { content: 'Done — Severance season 1 is downloading now.' },
  ];
  const stub = installSonarrFetchStub(turns, {
    library: [],
    lookupByTvdb: { 329865: [], 371980: severanceLookup },  // bad id resolves to nothing
    lookupByTerm: { Severance: severanceLookup },            // title search finds the real series
    onAdd: (b) => ({ id: 412, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'Just season 1', [], severanceHistory);
    assert.ok(r.job, 'self-healing add_tv should complete the add on the first call');
    assert.equal(r.job!.arrId, 412);
    assert.match(r.job!.title, /Severance/);
    assert.doesNotMatch(r.response, /wait a moment|hang on/i, 'no dangling stall');
    const calls = stub.calls();
    assert.ok(calls.some(c => c.includes('/series/lookup')), 'a title lookup must have happened to resolve the real id');
    assert.ok(calls.some(c => c.startsWith('POST') && /\/series$/.test(c)), 'series add POST should fire');
  } finally {
    stub.restore();
  }
});

test('self-healing add_tv clamps the requested season to the show real season list', async () => {
  // The model passed seasons:[1] for Severance — it must be honored exactly (season 1 monitored).
  // Verifies the add POST monitors only the requested season, not all.
  const turns: Turn[] = [
    tc('add_tv', { tvdb_id: 371980, title: 'Severance', seasons: [1] }),
    { content: 'Done — Severance season 1 is downloading.' },
  ];
  let addBody: any;
  const stub = installSonarrFetchStub(turns, {
    library: [],
    lookupByTvdb: { 371980: severanceLookup },
    lookupByTerm: { Severance: severanceLookup },
    onAdd: (b) => { addBody = b; return { id: 412, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }; },
  });
  try {
    const r = await runLocalSession('+15551234567', 'Just season 1', [], severanceHistory);
    assert.ok(r.job);
    const monitored = (addBody.seasons || []).filter((s: any) => s.seasonNumber > 0 && s.monitored).map((s: any) => s.seasonNumber);
    assert.deepEqual(monitored, [1], 'only season 1 should be monitored');
  } finally {
    stub.restore();
  }
});

test('season phrase OVERRIDES the model seasons array: user says "all seasons", model sends [1] -> all monitored', async () => {
  // The live "all seasons" bug (2026-05-22): user answers "all seasons" but the model builds
  // add_tv with seasons:[1]. The user's phrase is the source of truth — it must override the
  // model's array so every season is monitored, not just season 1.
  const fiveSeason = [{
    tvdbId: 403294, title: 'The Bear', year: 2022,
    seasons: [0, 1, 2, 3, 4, 5].map(n => ({ seasonNumber: n })),
  }];
  const turns: Turn[] = [
    tc('add_tv', { tvdb_id: 403294, title: 'The Bear', seasons: [1] }),  // model picked just [1]
    { content: 'Done — grabbing all seasons.' },
  ];
  let addBody: any;
  const stub = installSonarrFetchStub(turns, {
    library: [],
    lookupByTvdb: { 403294: fiveSeason },
    lookupByTerm: { 'The Bear': fiveSeason },
    onAdd: (b) => { addBody = b; return { id: 500, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }; },
  });
  const history = [
    { role: 'user', text: 'add The Bear', timestamp: '' },
    { role: 'assistant', text: 'Which seasons of The Bear would you like? It has 5.', timestamp: '' },
  ];
  try {
    const r = await runLocalSession('+15551234567', 'all seasons', [], history);
    assert.ok(r.job);
    const monitored = (addBody.seasons || []).filter((s: any) => s.seasonNumber > 0 && s.monitored).map((s: any) => s.seasonNumber);
    assert.deepEqual(monitored, [1, 2, 3, 4, 5], 'all seasons must be monitored, overriding the model [1]');
  } finally {
    stub.restore();
  }
});

test('season phrase OVERRIDES: user says "the latest season", model sends [1] -> only last monitored', async () => {
  const fiveSeason = [{
    tvdbId: 403294, title: 'The Bear', year: 2022,
    seasons: [0, 1, 2, 3, 4, 5].map(n => ({ seasonNumber: n })),
  }];
  const turns: Turn[] = [
    tc('add_tv', { tvdb_id: 403294, title: 'The Bear', seasons: [1] }),
    { content: 'Done.' },
  ];
  let addBody: any;
  const stub = installSonarrFetchStub(turns, {
    library: [],
    lookupByTvdb: { 403294: fiveSeason },
    lookupByTerm: { 'The Bear': fiveSeason },
    onAdd: (b) => { addBody = b; return { id: 500, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }; },
  });
  const history = [
    { role: 'user', text: 'add The Bear', timestamp: '' },
    { role: 'assistant', text: 'Which seasons of The Bear would you like? It has 5.', timestamp: '' },
  ];
  try {
    const r = await runLocalSession('+15551234567', 'just the latest season', [], history);
    assert.ok(r.job);
    const monitored = (addBody.seasons || []).filter((s: any) => s.seasonNumber > 0 && s.monitored).map((s: any) => s.seasonNumber);
    assert.deepEqual(monitored, [5], 'latest season = season 5 only');
  } finally {
    stub.restore();
  }
});

test('short dominant show: model asks instead of adding -> net #9 adds all seasons directly', async () => {
  // "add the show Severance" — a 2-season dominant show. The prompt says add a <3 season show right
  // away, but qwen2.5:7b sometimes asks a hybrid "is this the 2022 one? which seasons?" question. A
  // short dominant show needs no season question, so net #9 adds all its seasons directly.
  const twoSeason = [{
    tvdbId: 371980, title: 'Severance', year: 2022,
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }],
  }];
  const turns: Turn[] = [
    tc('search_tv', { query: 'Severance' }),
    { content: 'I found a couple of Severance shows. Is this the one from 2022? Which season(s) would you like?' },
  ];
  let addBody: any;
  const stub = installSonarrFetchStub(turns, {
    library: [],
    lookupByTvdb: { 371980: twoSeason },
    lookupByTerm: { Severance: twoSeason },
    onAdd: (b) => { addBody = b; return { id: 600, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }; },
  });
  try {
    const r = await runLocalSession('+15551234567', 'add the show Severance', []);
    assert.ok(r.job, 'a short dominant show should be added directly, not asked about');
    const monitored = (addBody.seasons || []).filter((s: any) => s.seasonNumber > 0 && s.monitored).map((s: any) => s.seasonNumber);
    assert.deepEqual(monitored, [1, 2], 'all (both) seasons of the short show monitored');
  } finally {
    stub.restore();
  }
});

test('short-show direct-add does NOT fire for an ambiguous title with sibling versions (The Office)', async () => {
  // "add The Office" — Sonarr returns The Office (2001 UK, 2 seasons) on top with siblings The
  // Office (US/AU/SA). It's a genuine multi-version ambiguity, so net #9 must NOT silently add the
  // UK one; the model's "which version?" ask should stand. Guarded by the sibling-versions check.
  const officeResults = [
    { tvdbId: 78107, title: 'The Office', year: 2001, seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }] },
    { tvdbId: 73244, title: 'The Office (US)', year: 2005, seasons: Array.from({ length: 10 }, (_, i) => ({ seasonNumber: i })) },
  ];
  const turns: Turn[] = [
    tc('search_tv', { query: 'The Office' }),
    { content: 'There are multiple versions of "The Office". Which one would you like?' },
  ];
  const stub = installSonarrFetchStub(turns, {
    library: [],
    lookupByTerm: { 'The Office': officeResults },
    lookupByTvdb: { 78107: [officeResults[0]] },
    onAdd: (b) => ({ id: 700, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'add The Office', []);
    assert.equal(r.job, undefined, 'must NOT auto-add an ambiguous multi-version title');
    assert.match(r.response, /which|version|\?/i, 'should leave the disambiguation question standing');
  } finally {
    stub.restore();
  }
});

test('add_tv ignores a hallucinated season number outside the show range (clamps to valid)', async () => {
  // The model sent [1,8] for a 5-season show (live, 2026-05-22). availableSeasons is the source of
  // truth: out-of-range numbers are dropped so a fabricated count can never monitor a nonexistent
  // season. Here a 2-season Severance + seasons:[1,8] must monitor only [1].
  const twoSeason = [{
    tvdbId: 371980, title: 'Severance', year: 2022,
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }],
  }];
  const turns: Turn[] = [
    tc('add_tv', { tvdb_id: 371980, title: 'Severance', seasons: [1, 8] }),
    { content: 'Done.' },
  ];
  let addBody: any;
  const stub = installSonarrFetchStub(turns, {
    library: [],
    lookupByTvdb: { 371980: twoSeason },
    lookupByTerm: { Severance: twoSeason },
    onAdd: (b) => { addBody = b; return { id: 412, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }; },
  });
  try {
    const r = await runLocalSession('+15551234567', 'Just season 1', [], severanceHistory);
    assert.ok(r.job);
    const monitored = (addBody.seasons || []).filter((s: any) => s.seasonNumber > 0 && s.monitored).map((s: any) => s.seasonNumber);
    assert.deepEqual(monitored, [1], 'season 8 does not exist and must be dropped');
  } finally {
    stub.restore();
  }
});

// --- Star City false-success bug (2026-05-31): the model fabricated a whole search→found→add flow
// from conversation history with ZERO tool calls, then told the user "I've added Star City Season 1"
// when nothing was added (and reported "4 seasons" for a 1-season show). These pin the fix: a false
// add-claim is NEVER delivered, a fabricated "found/N seasons" reply forces a real search, and a
// dominant short-show match is actually added. ---
const STAR_CITY = [{
  tvdbId: 449146, title: 'Star City', year: 2026,
  seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }],   // 1 real season (the live Sonarr truth)
}];

test('false add NEVER delivered: model claims "I\'ve added" with no tool call ever → honest failure, not a lie', async () => {
  // The exact Star City turn-3 worst case: the model keeps narrating a successful add but never
  // calls add_tv (or search_tv). Net #2 forces a search once; the model still won't act. The FINAL
  // GUARD must suppress the false "I've added" and return an honest failure — never the lie.
  const turns: Turn[] = [
    { content: "I've added Star City Season 1. It should be available soon!" },
    { content: "I've added Star City Season 1. It should be available soon!" },
    { content: "I've added Star City Season 1. It should be available soon!" },
  ];
  const stub = installSonarrFetchStub(turns, {
    library: [],
    lookupByTerm: { 'Star City': STAR_CITY },
    lookupByTvdb: { 449146: STAR_CITY },
    onAdd: (b) => ({ id: 851, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you get star city 2026', []);
    assert.equal(r.job, undefined, 'nothing was actually added, so there must be NO job');
    assert.doesNotMatch(r.response, /i'?ve added|added star city|it should be available/i,
      'must NOT deliver a false success confirmation');
    assert.match(r.response, /wasn'?t able to add|went wrong|nothing was actually added/i,
      'must deliver an honest failure');
  } finally {
    stub.restore();
  }
});

test('false add → net #2 forces a real search → dominant short show is actually added (real recovery)', async () => {
  // The model fabricates "I've added" (no tool). Net #2 forces a search; the search finds the real
  // 1-season Star City; the model again narrates "I've added" — net #9 (short dominant show) now
  // adds it for real. End state: a REAL add of the correct show, honest confirmation.
  const turns: Turn[] = [
    { content: "I've added Star City Season 1. It should be available soon!" },  // hop0 → net #2 forces search
    tc('search_tv', { query: 'Star City' }),                                     // hop1 → real search
    { content: "I've added Star City Season 1!" },                               // hop2 → net #9 real add
  ];
  let addBody: any;
  const stub = installSonarrFetchStub(turns, {
    library: [],
    lookupByTerm: { 'Star City': STAR_CITY },
    lookupByTvdb: { 449146: STAR_CITY },
    onAdd: (b) => { addBody = b; return { id: 852, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }; },
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you get star city 2026', []);
    assert.ok(r.job, 'the correct show should have been really added');
    assert.equal(r.job!.arrId, 852);
    assert.match(r.job!.title, /Star City/);
    assert.match(r.response, /added star city/i, 'honest confirmation of the real add');
    const monitored = (addBody.seasons || []).filter((s: any) => s.seasonNumber > 0 && s.monitored).map((s: any) => s.seasonNumber);
    assert.deepEqual(monitored, [1], 'the one real season is monitored');
  } finally {
    stub.restore();
  }
});

test('fabricated "Found X / 4 seasons" with no search → net #3b forces a real search → correct 1-season count', async () => {
  // Turn-1/2 shape: the model says "Found Star City. It has 4 seasons. Which seasons would you like?"
  // having NEVER searched. Net #3b forces a real search_tv; the real result is a 1-season show, so
  // the bogus "4 seasons" never reaches the user and the show is added from real data.
  const turns: Turn[] = [
    { content: 'Found Star City. It has 4 seasons available. Which seasons would you like? I can add all.' },
    tc('search_tv', { query: 'Star City' }),
    { content: 'Found Star City (2026). Which seasons would you like?' },
  ];
  const stub = installSonarrFetchStub(turns, {
    library: [],
    lookupByTerm: { 'Star City': STAR_CITY },
    lookupByTvdb: { 449146: STAR_CITY },
    onAdd: (b) => ({ id: 853, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you get star city 2026', []);
    const calls = stub.calls();
    assert.ok(calls.some(c => c.includes('/series/lookup')), 'a real search must have happened');
    assert.doesNotMatch(r.response, /4 seasons/i, 'the fabricated 4-season count must be gone');
    assert.ok(r.job, 'the real 1-season show should be added from the search result');
    assert.equal(r.job!.arrId, 853);
  } finally {
    stub.restore();
  }
});

// --- Status path: title-scoped check_status + the "wait a moment" status-stall (2026-05-22) ---
// A stub that serves Radarr movie lookups, Sonarr series lookups, and a per-id queue, so a
// title-scoped check_status can resolve a real state. `radarrLib`/`sonarrLib` map a lookup term
// to the library result; `queueByMovieId`/`queueBySeriesId` map an arr id to its queue records.
function installStatusFetchStub(turns: Turn[], cfg: {
  radarrLookup?: Record<string, any[]>;
  sonarrLookup?: Record<string, any[]>;
  queueByMovieId?: Record<number, any[]>;
  queueBySeriesId?: Record<number, any[]>;
}) {
  const realFetch = globalThis.fetch;
  let turnIdx = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    const method = init?.method || 'GET';
    calls.push(`${method} ${u.split('?')[0]}`);
    if (u.includes('/api/chat')) {
      const turn = turns[Math.min(turnIdx, turns.length - 1)];
      turnIdx++;
      return { ok: true, json: async () => ({ message: turn }) } as any;
    }
    if (u.includes('/movie/lookup')) {
      const m = decodeURIComponent(u).match(/term=([^&]+)/);
      return { ok: true, json: async () => (cfg.radarrLookup?.[m ? m[1] : ''] || []) } as any;
    }
    if (u.includes('/series/lookup')) {
      const m = decodeURIComponent(u).match(/term=([^&]+)/);
      return { ok: true, json: async () => (cfg.sonarrLookup?.[m ? m[1] : ''] || []) } as any;
    }
    if (u.includes('/queue')) {
      const mm = u.match(/movieId=(\d+)/);
      const sm = u.match(/seriesId=(\d+)/);
      const records = mm ? (cfg.queueByMovieId?.[Number(mm[1])] || [])
        : sm ? (cfg.queueBySeriesId?.[Number(sm[1])] || []) : [];
      return { ok: true, json: async () => ({ records }) } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  }) as any;
  return { restore: () => { globalThis.fetch = realFetch; }, calls: () => calls };
}

test('status-stall: "status of severance" → model stalls "wait a moment" → forced title-scoped check_status reports real state', async () => {
  // Jeff's EXACT bug trace: status request → model replies "I'm checking the status of Severance
  // now. Can you wait a moment?" (ends in ?) → net #6 must FORCE check_status with the title →
  // model calls it → reports Severance's actual state. NO dangling "wait a moment".
  const turns: Turn[] = [
    { content: 'I\'m checking the status of "Severance" now. Can you wait a moment?' }, // the stall
    tc('check_status', { title: 'Severance' }),                                          // forced
    { content: 'Severance is downloading, about 40% done.' },
  ];
  const stub = installStatusFetchStub(turns, {
    sonarrLookup: { Severance: [{ id: 412, tvdbId: 371980, title: 'Severance', year: 2022, seasons: [{ seasonNumber: 1 }] }] },
    queueBySeriesId: { 412: [{ id: 1, status: 'downloading', size: 1000, sizeleft: 600 }] },
  });
  try {
    const r = await runLocalSession('+15551234567', "What's the status of severance", []);
    assert.doesNotMatch(r.response, /wait a moment|hang on|checking the status/i, 'must not end on a stall');
    assert.match(r.response, /40%|downloading/i, 'must report the real downloading state');
    const calls = stub.calls();
    assert.ok(calls.some(c => c.includes('/series/lookup')), 'a title-scoped status lookup must have happened');
  } finally {
    stub.restore();
  }
});

test('status-stall: "How is severance doing" (the 2026-05-22 leak) → stall intercepted, real state reported', async () => {
  // The leaked phrasing: "How is severance doing" did not match isStatusQuery, so net #6 never
  // armed and the "I'm checking the status... wait a moment?" stall was DELIVERED to the user.
  // Now isStatusQuery catches it (and the universal backstop is a second line of defense). The
  // returned response must be the real state, NEVER the stall.
  const turns: Turn[] = [
    { content: 'I\'m checking the status of "Severance" now. Can you wait a moment?' }, // the stall
    tc('check_status', { title: 'Severance' }),                                          // forced
    { content: 'Severance is downloading, about 55% done.' },
  ];
  const stub = installStatusFetchStub(turns, {
    sonarrLookup: { Severance: [{ id: 412, tvdbId: 371980, title: 'Severance', year: 2022, seasons: [{ seasonNumber: 1 }] }] },
    queueBySeriesId: { 412: [{ id: 1, status: 'downloading', size: 1000, sizeleft: 450 }] },
  });
  try {
    const r = await runLocalSession('+15551234567', 'How is severance doing', []);
    assert.doesNotMatch(r.response, /wait a moment|hang on|checking the status/i, 'the stall must NOT be delivered');
    assert.match(r.response, /55%|downloading/i, 'must report the real downloading state in one message');
  } finally {
    stub.restore();
  }
});

test('universal stall backstop: a search request that stalls (slips past net gating) is intercepted', async () => {
  // A non-status request where the model stalls instead of searching. Even if the specific search
  // nets did not arm, the universal backstop (net #12) must force the tool and never deliver the stall.
  const turns: Turn[] = [
    { content: "Sure! I'm searching for that now, hang on a sec." },   // pure stall, no tool, no add verb match edge
    tc('search_movie', { query: 'Whiplash' }),                          // forced by backstop
    tc('add_movie', { tmdb_id: 244786, title: 'Whiplash' }),
    { content: 'Added Whiplash (2014) — it should be ready soon.' },
  ];
  const stub = installFetchStub(turns, {
    lookupByTerm: { Whiplash: [{ id: 0, tmdbId: 244786, title: 'Whiplash', year: 2014 }] },
    lookupByTmdb: { 244786: [{ id: 0, tmdbId: 244786, title: 'Whiplash', year: 2014 }] },
    onAdd: (b) => ({ id: 501, ...b }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'can you get whiplash', []);
    assert.doesNotMatch(r.response, /hang on|wait a|searching for that now/i, 'the stall must NOT be delivered');
    assert.match(r.response, /added|whiplash/i, 'must report the real result');
  } finally {
    stub.restore();
  }
});

test('status-stall: not-added title → forced check_status reports "not in your library yet"', async () => {
  const turns: Turn[] = [
    { content: "Let me check on that for you, one moment." },        // stall
    tc('check_status', { title: 'Severance' }),                       // forced
    { content: "Severance isn't in your library yet — want me to add it?" },
  ];
  const stub = installStatusFetchStub(turns, {
    radarrLookup: { Severance: [{ id: 0, tmdbId: 1, title: 'Severance', year: 2022 }] }, // not in lib (id 0)
    sonarrLookup: { Severance: [{ id: 0, tvdbId: 371980, title: 'Severance', year: 2022, seasons: [] }] },
  });
  try {
    const r = await runLocalSession('+15551234567', 'is severance ready yet?', []);
    assert.match(r.response, /isn'?t in your library|not (in your library|added)|want me to add/i);
    assert.doesNotMatch(r.response, /wait a moment|one moment|let me check/i, 'must not end on a stall');
  } finally {
    stub.restore();
  }
});

test('status-stall never resolves → honest error, never a dangling "wait a moment"', async () => {
  const turns: Turn[] = [
    { content: "I'm checking now, one moment please." },
    { content: 'Hang on, almost there.' },
    { content: 'Give me a second, still looking it up.' },
    { content: 'Just a moment more, checking.' },
    { content: 'Nearly done, please wait.' },
    { content: 'Still checking, hold on.' },
  ];
  const stub = installStatusFetchStub(turns, {
    sonarrLookup: { Severance: [{ id: 412, tvdbId: 371980, title: 'Severance', year: 2022, seasons: [] }] },
  });
  try {
    const r = await runLocalSession('+15551234567', "what's the status of severance", []);
    assert.match(r.response, /couldn'?t pull|try again|another try/i, 'should be an honest error');
    assert.doesNotMatch(r.response, /wait a moment|one moment|hang on/i, 'must not be a dangling stall');
  } finally {
    stub.restore();
  }
});

test('global status: "what\'s downloading?" still works (no title) — net #6 forces a global check_status', async () => {
  // The no-title path must still function. Model stalls, net #6 forces a global check_status
  // (no title param), which sweeps active jobs.
  const turns: Turn[] = [
    { content: "Let me check what's downloading, one sec." },  // stall
    tc('check_status', {}),                                     // forced GLOBAL (no title)
    { content: 'Nothing is currently downloading.' },
  ];
  const stub = installStatusFetchStub(turns, {});
  try {
    const r = await runLocalSession('+15551234567', "what's downloading?", []);
    assert.match(r.response, /nothing.*downloading|currently downloading/i);
    assert.doesNotMatch(r.response, /one sec|let me check/i, 'must not end on a stall');
    // No title means no library lookup — just the global sweep over active jobs (empty here).
    const calls = stub.calls();
    assert.ok(!calls.some(c => c.includes('/lookup')), 'global status must not do a title lookup');
  } finally {
    stub.restore();
  }
});

test('status: model checks immediately (no stall) → reports without net #6 interfering', async () => {
  // The happy path: model does the right thing first try. Net #6 must NOT fire (it's gated on
  // !statusToolUsed) and the real state is reported.
  const turns: Turn[] = [
    tc('check_status', { title: 'Oppenheimer' }),
    { content: 'Oppenheimer is in your library and ready to watch.' },
  ];
  const stub = installStatusFetchStub(turns, {
    radarrLookup: { Oppenheimer: [{ id: 360, tmdbId: 872585, title: 'Oppenheimer', year: 2023, hasFile: true }] },
  });
  try {
    const r = await runLocalSession('+15551234567', 'is Oppenheimer ready?', []);
    assert.match(r.response, /ready to watch|in your library/i);
  } finally {
    stub.restore();
  }
});

test('net #8 over-disambiguation: "add The Matrix" → search → model asks "which one?" → forced add of dominant top result', async () => {
  // qwen2.5:7b searches, gets The Matrix (1999) as the dominant top result (sequels below), but
  // asks "which one?" instead of adding. Net #8 must force add_movie of the top result.
  const turns: Turn[] = [
    tc('search_movie', { query: 'The Matrix' }),
    { content: 'I found a few Matrix movies. Which one did you mean?' },           // needless ask
    tc('add_movie', { tmdb_id: 603, title: 'The Matrix' }),                        // forced add
    { content: 'Done — The Matrix (1999) is downloading now.' },
  ];
  const stub = installFetchStub(turns, {
    library: [],
    lookupByTerm: {
      'The Matrix': [
        { tmdbId: 603, title: 'The Matrix', year: 1999, id: 0 },
        { tmdbId: 604, title: 'The Matrix Reloaded', year: 2003, id: 0 },
        { tmdbId: 624860, title: 'The Matrix Resurrections', year: 2021, id: 0 },
      ],
    },
    lookupByTmdb: { 603: [{ tmdbId: 603, title: 'The Matrix', year: 1999 }] },
    onAdd: (b) => ({ id: 501, title: b.title, tmdbId: b.tmdbId, year: 1999 }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'add The Matrix', []);
    assert.ok(r.job, 'should add the dominant top result rather than ending on a "which one?" ask');
    assert.equal(r.job!.arrId, 501);
    assert.match(r.job!.title, /Matrix/);
    assert.doesNotMatch(r.response, /which one|did you mean/i, 'must not end on a needless disambiguation');
    const calls = stub.calls();
    assert.ok(calls.some(c => c.startsWith('POST') && /\/movie$/.test(c)), 'movie add POST should fire');
  } finally {
    stub.restore();
  }
});

test('net #8 Whiplash: many same-title films but a clear popularity winner → forced add of the 2014 one', async () => {
  // "Whiplash" returns 7 films literally titled Whiplash; the 2014 one (pop 21.7) dwarfs the rest
  // (next 1.5). Title alone is ambiguous, but the popularity gap makes 2014 dominant → net #8 adds it.
  const turns: Turn[] = [
    tc('search_movie', { query: 'Whiplash' }),
    { content: 'I found a few Whiplash movies. The most likely is the 2014 one. Should I add that?' },
    tc('add_movie', { tmdb_id: 244786, title: 'Whiplash' }),
    { content: 'Done — Whiplash (2014) is downloading now.' },
  ];
  const stub = installFetchStub(turns, {
    library: [],
    lookupByTerm: {
      Whiplash: [
        { tmdbId: 244786, title: 'Whiplash', year: 2014, id: 0, popularity: 21.7 },
        { tmdbId: 1, title: 'Whiplash', year: 2013, id: 0, popularity: 1.5 },
        { tmdbId: 2, title: 'Whiplash', year: 1948, id: 0, popularity: 1.2 },
      ],
    },
    lookupByTmdb: { 244786: [{ tmdbId: 244786, title: 'Whiplash', year: 2014 }] },
    onAdd: (b) => ({ id: 502, title: b.title, tmdbId: b.tmdbId, year: 2014 }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'Whiplash', []);
    assert.ok(r.job, 'should add the popularity-dominant 2014 Whiplash');
    assert.equal(r.job!.arrId, 502);
    assert.doesNotMatch(r.response, /which one|should i add/i, 'must not end on a needless confirm');
  } finally {
    stub.restore();
  }
});

test('net #8 PRESERVES genuine ambiguity: same-title films of comparable popularity → NO auto-add', async () => {
  // "add Crash" returns distinct films literally titled Crash with comparable popularity — no clear
  // winner. Net #8 must NOT fire; the model's "which one?" stands and nothing is auto-added.
  const turns: Turn[] = [
    tc('search_movie', { query: 'Crash' }),
    { content: 'I found a few films called Crash — which one did you mean, the 2005 or 1996 one?' },
    { content: 'I found a few films called Crash — which one did you mean, the 2005 or 1996 one?' },
  ];
  const stub = installFetchStub(turns, {
    library: [],
    lookupByTerm: {
      Crash: [
        { tmdbId: 1, title: 'Crash', year: 2005, id: 0, popularity: 12 },
        { tmdbId: 2, title: 'Crash', year: 1996, id: 0, popularity: 9 },
      ],
    },
  });
  try {
    const r = await runLocalSession('+15551234567', 'add Crash', []);
    assert.equal(r.job, undefined, 'must NOT auto-add when genuinely ambiguous');
    assert.match(r.response, /which|2005|1996/i, 'should still be asking which one');
    const calls = stub.calls();
    assert.ok(!calls.some(c => c.startsWith('POST') && /\/movie$/.test(c)), 'no add should fire on a coin-flip');
  } finally {
    stub.restore();
  }
});

test('net #8 does NOT override the TV "which seasons?" ask (a 3+ season show)', async () => {
  // "add Severance" → search_tv finds a 3+ season show. The model correctly asks which seasons.
  // That is NOT over-disambiguation (pendingSeasonQuestion is set) — net #8 must leave it alone.
  const turns: Turn[] = [
    tc('search_tv', { query: 'Severance' }),
    { content: 'Severance has 4 seasons — which seasons would you like, or all of them?' },
    { content: 'Severance has 4 seasons — which seasons would you like, or all of them?' },
  ];
  const stub = installSonarrFetchStub(turns, {
    library: [],
    lookupByTerm: { Severance: [{
      tvdbId: 371980, title: 'Severance', year: 2022,
      seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }, { seasonNumber: 4 }],
    }] },
  });
  try {
    const r = await runLocalSession('+15551234567', 'add Severance', []);
    assert.equal(r.job, undefined, 'must not auto-add — the seasons question is correct');
    assert.match(r.response, /which seasons|all of them/i, 'should still ask which seasons');
  } finally {
    stub.restore();
  }
});

test('post-search stall: model searches, finds it, then stalls before adding -> net #5 forces the add', async () => {
  // A short (<3 season) movie-like correction path where the model DID search but then stalls
  // ("found it! adding now, hang on") with no add tool. Net #5 must drive the add.
  const turns: Turn[] = [
    tc('search_movie', { query: 'Memento' }),
    { content: 'Found Memento (2000)! Adding it now, hang on a sec.' },   // post-search stall
    tc('add_movie', { tmdb_id: 77, title: 'Memento' }),
    { content: 'Done — Memento is downloading.' },
  ];
  const stub = installFetchStub(turns, {
    library: [],
    lookupByTerm: { Memento: [{ tmdbId: 77, title: 'Memento', year: 2000, id: 0 }] },
    lookupByTmdb: { 77: [{ tmdbId: 77, title: 'Memento', year: 2000 }] },
    onAdd: (b) => ({ id: 88, title: b.title, tmdbId: b.tmdbId, year: 2000 }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'add Memento', []);
    assert.ok(r.job, 'should add after a post-search stall');
    assert.equal(r.job!.arrId, 88);
    assert.doesNotMatch(r.response, /hang on|adding it now/i, 'must not end on the stall');
  } finally {
    stub.restore();
  }
});

// --- Raw tool-call string in content: PARSE + EXECUTE, never deliver (the live Apex bug, 2026-05-22) ---

test('raw tool-call string `search_movie({...})` is recovered + executed, never delivered to the user', async () => {
  // The EXACT live failure: after the promise-net forced a tool call, qwen2.5:7b emitted the call as
  // LITERAL TEXT — `search_movie({"query": "Apex"})` — and the bot delivered that raw string. With the
  // fix, recoverToolCalls parses the inline syntax and runs the real search, then the add completes.
  const turns: Turn[] = [
    { content: 'search_movie({"query": "Apex"})' },                       // tool call emitted as TEXT
    tc('add_movie', { tmdb_id: 12244, title: 'Apex' }),                   // model adds from results
    { content: 'Added Apex (2019) — grabbing it now.' },
  ];
  const stub = installFetchStub(turns, {
    library: [],
    lookupByTerm: { Apex: [{ tmdbId: 12244, title: 'Apex', year: 2019, id: 0 }] },
    lookupByTmdb: { 12244: [{ tmdbId: 12244, title: 'Apex', year: 2019 }] },
    onAdd: (b) => ({ id: 501, title: b.title, tmdbId: b.tmdbId, year: 2019 }),
  });
  try {
    const r = await runLocalSession('+15551234567', "It's a movie", []);
    assert.ok(r.job, 'the inline tool call must be executed, leading to a real add');
    assert.equal(r.job!.arrId, 501);
    assert.doesNotMatch(r.response, /search_movie\(/, 'must NEVER deliver the raw tool-call string');
    const calls = stub.calls();
    assert.ok(calls.some(c => c.includes('/movie/lookup')), 'the recovered search must have actually run');
  } finally {
    stub.restore();
  }
});

test('a single inline search_movie call resolves to a one-result direct add (no raw string leak)', async () => {
  // Even when the model ONLY ever emits the inline string (no follow-up turn), it must be executed
  // and never delivered. Here the recovered search returns one result; the model then adds it.
  const turns: Turn[] = [
    { content: 'Sure, let me look. search_movie({"query":"Apex"})' },     // inline call w/ prose
    tc('add_movie', { tmdb_id: 12244, title: 'Apex' }),
    { content: 'Got it — Apex (2019) is downloading.' },
  ];
  const stub = installFetchStub(turns, {
    library: [],
    lookupByTerm: { Apex: [{ tmdbId: 12244, title: 'Apex', year: 2019, id: 0 }] },
    lookupByTmdb: { 12244: [{ tmdbId: 12244, title: 'Apex', year: 2019 }] },
    onAdd: (b) => ({ id: 502, title: b.title, tmdbId: b.tmdbId, year: 2019 }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can we get Apex?', []);
    assert.ok(r.job, 'the inline call wrapped in prose must still execute');
    assert.doesNotMatch(r.response, /search_movie\(/, 'must never deliver the raw tool-call string');
  } finally {
    stub.restore();
  }
});

test('a MALFORMED raw tool-call string is suppressed → honest error, never delivered', async () => {
  // The arg JSON is broken so recoverToolCalls can't execute it. The final guard must SUPPRESS it
  // (re-force a real tool call), and if the model keeps emitting garbage, bail to an honest error —
  // it must NEVER deliver the literal `search_movie(...)` text.
  const turns: Turn[] = [
    { content: 'search_movie({"query": "Apex"' },   // broken JSON — unrecoverable
  ];
  const stub = installFetchStub(turns, { library: [] });
  try {
    const r = await runLocalSession('+15551234567', "It's a movie", []);
    assert.doesNotMatch(r.response, /search_movie\(/, 'must NEVER deliver the raw tool-call string');
    assert.match(r.response, /snag|try again|try .* in a sec/i, 'should be an honest error after re-forcing fails');
  } finally {
    stub.restore();
  }
});

// --- Cross-type search fallback (net #13): movie↔TV. A combined stub serving BOTH Radarr movie
// lookups AND Sonarr series lookups so a movie-first-empty turn can fall through to a TV search
// (and vice-versa) within one session. Jeff's bug (2026-05-23): "keep sweet pray and obey" is a TV
// show, a movie-first search found nothing, and Jedd said "couldn't find that one" without trying TV.
function installCrossTypeFetchStub(turns: Turn[], cfg: {
  radarrByTerm?: Record<string, any[]>;
  radarrByTmdb?: Record<number, any[]>;
  sonarrByTerm?: Record<string, any[]>;
  sonarrByTvdb?: Record<number, any[]>;
  onMovieAdd?: (body: any) => any;
  onTvAdd?: (body: any) => any;
}) {
  const realFetch = globalThis.fetch;
  let turnIdx = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    const method = init?.method || 'GET';
    calls.push(`${method} ${u.split('?')[0]}`);
    if (u.includes('/api/chat')) {
      const turn = turns[Math.min(turnIdx, turns.length - 1)];
      turnIdx++;
      return { ok: true, json: async () => ({ message: turn }) } as any;
    }
    if (u.includes('/movie/lookup')) {
      const m = decodeURIComponent(u).match(/term=([^&]+)/);
      const term = m ? m[1] : '';
      if (term.startsWith('tmdb:')) {
        const id = Number(term.slice(5));
        return { ok: true, json: async () => (cfg.radarrByTmdb?.[id] || []) } as any;
      }
      return { ok: true, json: async () => (cfg.radarrByTerm?.[term] || []) } as any;
    }
    if (u.includes('/series/lookup')) {
      const m = decodeURIComponent(u).match(/term=([^&]+)/);
      const term = m ? m[1] : '';
      if (term.startsWith('tvdb:')) {
        const id = Number(term.slice(5));
        return { ok: true, json: async () => (cfg.sonarrByTvdb?.[id] || []) } as any;
      }
      return { ok: true, json: async () => (cfg.sonarrByTerm?.[term] || []) } as any;
    }
    if (/\/movie(\?|$)/.test(u) && method === 'POST') {
      const body = JSON.parse(init.body);
      return { ok: true, json: async () => (cfg.onMovieAdd ? cfg.onMovieAdd(body) : { id: 999, ...body }) } as any;
    }
    if (/\/series(\?|$)/.test(u) && method === 'POST') {
      const body = JSON.parse(init.body);
      return { ok: true, json: async () => (cfg.onTvAdd ? cfg.onTvAdd(body) : { id: 888, ...body }) } as any;
    }
    if (/\/movie$/.test(u.split('?')[0]) && method === 'GET' && !/\/movie\/\d/.test(u)) {
      return { ok: true, json: async () => [] } as any;
    }
    if (/\/series$/.test(u.split('?')[0]) && method === 'GET' && !/\/series\/\d/.test(u)) {
      return { ok: true, json: async () => [] } as any;
    }
    if (u.includes('/queue')) return { ok: true, json: async () => ({ records: [] }) } as any;
    return { ok: true, json: async () => ({}) } as any;
  }) as any;
  return { restore: () => { globalThis.fetch = realFetch; }, calls: () => calls };
}

test('net #13 cross-type: bare TV-only title — movie search empty → forced search_tv finds it → adds', async () => {
  // Jeff's exact bug: "keep sweet pray and obey" is a TV show. The model defaults to search_movie,
  // gets nothing, and tries to say "couldn't find that one". Net #13 must force search_tv BEFORE the
  // not-found reply; the TV search finds a short (2-season) dominant show → net #9 adds it directly.
  const tvResults = [{
    tvdbId: 400123, title: 'Keep Sweet: Pray and Obey', year: 2022,
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }],
  }];
  const turns: Turn[] = [
    tc('search_movie', { query: 'keep sweet pray and obey' }),                 // movie-first, empty
    { content: "Couldn't find that one, sorry." },                              // about to give up → net #13
    tc('search_tv', { query: 'keep sweet pray and obey' }),                     // forced cross-search
    { content: 'I found Keep Sweet: Pray and Obey. Which seasons?' },           // short dominant → net #9 adds
  ];
  let addBody: any;
  const stub = installCrossTypeFetchStub(turns, {
    radarrByTerm: { 'keep sweet pray and obey': [] },                           // movie: nothing
    sonarrByTerm: { 'keep sweet pray and obey': tvResults },                    // TV: found
    sonarrByTvdb: { 400123: tvResults },
    onTvAdd: (b) => { addBody = b; return { id: 911, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }; },
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you get keep sweet pray and obey', []);
    assert.ok(r.job, 'should have found and added the TV show via the cross-type fallback');
    assert.match(r.job!.title, /Keep Sweet/i);
    assert.doesNotMatch(r.response, /couldn'?t find/i, 'must NOT say not-found after only a movie search');
    const calls = stub.calls();
    assert.ok(calls.some(c => c.includes('/movie/lookup')), 'movie search ran first');
    assert.ok(calls.some(c => c.includes('/series/lookup')), 'TV cross-search must have run');
  } finally {
    stub.restore();
  }
});

test('net #13 cross-type: bare movie-only title — TV search empty → forced search_movie finds it → adds', async () => {
  // Reverse direction: the model happens to try search_tv first on a bare title, gets nothing, and
  // is about to give up. Net #13 forces search_movie, which finds the film → net #8 adds the dominant.
  const movieResults = [{ tmdbId: 27205, title: 'Inception', year: 2010, id: 0 }];
  const turns: Turn[] = [
    tc('search_tv', { query: 'Inception' }),                                    // TV-first, empty
    { content: "I couldn't find that show." },                                  // about to give up → net #13
    tc('search_movie', { query: 'Inception' }),                                 // forced cross-search
    { content: 'I found Inception (2010). Which one did you mean?' },            // needless ask → net #8 forces add
    tc('add_movie', { tmdb_id: 27205, title: 'Inception' }),                    // forced add
    { content: 'Done — Inception (2010) is downloading now.' },
  ];
  const stub = installCrossTypeFetchStub(turns, {
    sonarrByTerm: { Inception: [] },                                            // TV: nothing
    radarrByTerm: { Inception: movieResults },                                  // movie: found
    radarrByTmdb: { 27205: [{ tmdbId: 27205, title: 'Inception', year: 2010 }] },
    onMovieAdd: (b) => ({ id: 920, title: b.title, tmdbId: b.tmdbId, year: 2010 }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'get me Inception', []);
    assert.ok(r.job, 'should have found and added the movie via the cross-type fallback');
    assert.match(r.job!.title, /Inception/i);
    assert.doesNotMatch(r.response, /couldn'?t find|could not find/i, 'must NOT say not-found after only a TV search');
    const calls = stub.calls();
    assert.ok(calls.some(c => c.includes('/series/lookup')), 'TV search ran first');
    assert.ok(calls.some(c => c.includes('/movie/lookup')), 'movie cross-search must have run');
  } finally {
    stub.restore();
  }
});

test('net #13 cross-type: genuine nonsense — BOTH movie and TV empty → "couldn\'t find that one"', async () => {
  // A real not-found: nothing matches as a movie OR a show. Net #13 forces the cross-search once,
  // it also comes back empty, and the model's not-found reply is then allowed to stand (no loop).
  const turns: Turn[] = [
    tc('search_movie', { query: 'asdfqwerzxcv nonsense title' }),
    { content: "Couldn't find that one, sorry." },                              // net #13 forces cross-search
    tc('search_tv', { query: 'asdfqwerzxcv nonsense title' }),                  // also empty
    { content: "Couldn't find that one, sorry." },                              // now allowed to stand
  ];
  const stub = installCrossTypeFetchStub(turns, {
    radarrByTerm: { 'asdfqwerzxcv nonsense title': [] },
    sonarrByTerm: { 'asdfqwerzxcv nonsense title': [] },
  });
  try {
    const r = await runLocalSession('+15551234567', 'can you get asdfqwerzxcv nonsense title', []);
    assert.equal(r.job, undefined, 'nothing should be added for a genuine nonsense title');
    assert.match(r.response, /couldn'?t find/i, 'should report not-found after BOTH searches came back empty');
    const calls = stub.calls();
    assert.ok(calls.some(c => c.includes('/movie/lookup')), 'movie search ran');
    assert.ok(calls.some(c => c.includes('/series/lookup')), 'TV cross-search ran before giving up');
  } finally {
    stub.restore();
  }
});

test('net #14 carry-forward: cross-search FINDS a short show but model still says not-found → forces the add', async () => {
  // The live "U.S. Against the World" bug (2026-06-16): movie search empty → net #13 forced search_tv
  // → the search FOUND the docuseries → but the model STILL replied "couldn't find it as a movie or a
  // TV show", discarding the result it had in hand. Jeff then had to nudge "it's a tv show". Net #14
  // must NOT accept that not-found while a dominant match is in hand — it forces the add of the found
  // (short, 1-season) show instead of dropping it.
  const tvResults = [{
    tvdbId: 412233, title: 'U.S. Against the World', year: 2023,
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }],
  }];
  const turns: Turn[] = [
    tc('search_movie', { query: 'U.S. Against the World' }),                    // movie-first, empty
    { content: "Couldn't find that one, sorry." },                              // about to give up → net #13
    tc('search_tv', { query: 'U.S. Against the World' }),                       // forced cross-search → FINDS it
    { content: "I couldn't find it as a movie or a TV show." },                 // BUG: discards the found result → net #14
    tc('add_tv', { tvdb_id: 412233, title: 'U.S. Against the World' }),         // net #14 forces the add
    { content: 'Done — U.S. Against the World is downloading now.' },
  ];
  const stub = installCrossTypeFetchStub(turns, {
    radarrByTerm: { 'U.S. Against the World': [] },                             // movie: nothing
    sonarrByTerm: { 'U.S. Against the World': tvResults },                      // TV: found
    sonarrByTvdb: { 412233: tvResults },
    onTvAdd: (b) => ({ id: 933, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you get U.S. Against the World', []);
    assert.ok(r.job, 'should carry the cross-search result forward and add it, not drop it');
    assert.match(r.job!.title, /U\.S\. Against the World/i);
    assert.doesNotMatch(r.response, /couldn'?t find|could not find/i, 'must NOT deliver not-found when the show WAS found');
    const calls = stub.calls();
    assert.ok(calls.some(c => c.includes('/series/lookup')), 'TV cross-search ran');
    assert.ok(calls.some(c => /\/series(\?|$)/.test(c.split(' ')[1] || c)), 'add_tv POST must have happened');
  } finally {
    stub.restore();
  }
});

test('net #14 carry-forward: cross-search finds a LONG show but model says not-found → forces the seasons question', async () => {
  // Same not-found-despite-a-match bug, but the found show has 3+ seasons. Adding all of it silently
  // would be wrong — Jedd must surface the show and ASK which seasons (the model dropped it instead).
  const tvResults = [{
    tvdbId: 305288, title: 'Some Long Docuseries', year: 2019,
    seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }, { seasonNumber: 4 }],
  }];
  const turns: Turn[] = [
    tc('search_movie', { query: 'Some Long Docuseries' }),                      // movie-first, empty
    { content: "Couldn't find that one, sorry." },                              // → net #13
    tc('search_tv', { query: 'Some Long Docuseries' }),                         // forced cross-search → FINDS it
    { content: "I couldn't find it as a movie or a TV show." },                 // BUG → net #14
    { content: 'I found Some Long Docuseries (2019). It has 4 seasons — which seasons would you like, or all?' },
  ];
  const stub = installCrossTypeFetchStub(turns, {
    radarrByTerm: { 'Some Long Docuseries': [] },
    sonarrByTerm: { 'Some Long Docuseries': tvResults },
    sonarrByTvdb: { 305288: tvResults },
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you get Some Long Docuseries', []);
    assert.equal(r.job, undefined, 'a long show needs a season choice first — nothing added yet');
    assert.doesNotMatch(r.response, /couldn'?t find|could not find/i, 'must NOT deliver not-found when the show WAS found');
    assert.match(r.response, /season/i, 'should ask which seasons of the found show');
    assert.match(r.response, /Some Long Docuseries/i, 'should name the found show, not a different one');
    const calls = stub.calls();
    assert.equal(calls.filter(c => /\/series(\?|$)/.test((c.split(' ')[1] || c)) && c.startsWith('POST')).length, 0, 'must NOT add a long show before the user picks seasons');
  } finally {
    stub.restore();
  }
});

test('net #14 does NOT fire on a genuine miss: search returns only near-miss titles → not-found stands', async () => {
  // Guard against over-firing: if the cross-search returns only UNRELATED near-miss titles (not a
  // dominant match for the query), the model's not-found reply is honest and must be allowed to stand.
  const turns: Turn[] = [
    tc('search_movie', { query: 'Zxqv Wibble Nonsense' }),                      // movie-first, empty
    { content: "Couldn't find that one, sorry." },                              // → net #13
    tc('search_tv', { query: 'Zxqv Wibble Nonsense' }),                         // cross-search → only a near-miss
    { content: "Couldn't find that one, sorry." },                              // honest not-found — must stand
  ];
  const stub = installCrossTypeFetchStub(turns, {
    radarrByTerm: { 'Zxqv Wibble Nonsense': [] },
    // A wholly-unrelated title, so topResultIsDominant() is false (no close match to the query).
    sonarrByTerm: { 'Zxqv Wibble Nonsense': [{ tvdbId: 1, title: 'Completely Different Show', year: 2001, seasons: [{ seasonNumber: 1 }] }] },
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you get Zxqv Wibble Nonsense', []);
    assert.equal(r.job, undefined, 'nothing should be added for a non-dominant near-miss');
    assert.match(r.response, /couldn'?t find/i, 'honest not-found must stand when there is no dominant match');
  } finally {
    stub.restore();
  }
});

test('net #13 does NOT fire when the user explicitly said "movie" (respect the type)', async () => {
  // "get me the movie Severance" — the user pinned MOVIE. A movie-empty result must NOT trigger a TV
  // cross-search; the not-found reply stands and no /series/lookup happens.
  const turns: Turn[] = [
    tc('search_movie', { query: 'Severance' }),
    { content: "Couldn't find that movie, sorry." },
    { content: "Couldn't find that movie, sorry." },
  ];
  const stub = installCrossTypeFetchStub(turns, {
    radarrByTerm: { Severance: [] },
    sonarrByTerm: { Severance: [{ tvdbId: 371980, title: 'Severance', year: 2022, seasons: [{ seasonNumber: 1 }] }] },
  });
  try {
    const r = await runLocalSession('+15551234567', 'get me the movie Severance', []);
    assert.equal(r.job, undefined, 'must not add — user asked for a movie and there is no movie');
    assert.match(r.response, /couldn'?t find/i);
    const calls = stub.calls();
    assert.ok(!calls.some(c => c.includes('/series/lookup')), 'must NOT cross-search TV when user said movie');
  } finally {
    stub.restore();
  }
});

// --- Multi-movie / franchise requests (nets A + B + C, 2026-05-24) -------------------------------
const dmCollection = (title: string, year: number, tmdbId: number, id = 0, hasFile = false) =>
  ({ title, year, tmdbId, id, hasFile, collection: { title: 'Despicable Me Collection', tmdbId: 86066 } });

test('net B — "get all the despicable me movies" → adds the whole collection by REAL id, one JOB per film', async () => {
  let nextId = 700;
  const stub = installFetchStub([], {
    lookupByTerm: { 'despicable me': [
      dmCollection('Despicable Me', 2010, 20352),
      dmCollection('Despicable Me 4', 2024, 519182),
      dmCollection('Despicable Me 2', 2013, 93456),
      dmCollection('Despicable Me 3', 2017, 324852),
      { title: 'Despicable Me Presents: Minion Madness', year: 2010, tmdbId: 286558, id: 0, hasFile: false }, // no collection → excluded
    ] },
    onAdd: (b) => ({ id: nextId++, title: b.title, tmdbId: b.tmdbId }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'Can you just get all of the despicable me movies?', []);
    for (const t of ['Despicable Me (2010)', 'Despicable Me 2 (2013)', 'Despicable Me 3 (2017)', 'Despicable Me 4 (2024)']) {
      assert.match(r.response, new RegExp(t.replace(/[()]/g, '\\$&')), `should mention ${t}`);
    }
    assert.doesNotMatch(r.response, /Minion Madness/, 'non-collection extra must be excluded');
    assert.equal([...r.response.matchAll(/<!--JOB:movie:\d+:/g)].length, 4, 'one JOB tag per film');
  } finally {
    stub.restore();
  }
});

test('net A — "get 3 and 4 as well" → adds the 3rd & 4th franchise films (real ids, franchise from history)', async () => {
  const hist = [
    { role: 'user', text: 'Can you get despicable me?', timestamp: '' },
    { role: 'assistant', text: "I've added Despicable Me (2010) to your library and it's now searching.", timestamp: '' },
    { role: 'user', text: 'How about the second one', timestamp: '' },
    { role: 'assistant', text: "I've added Despicable Me 2 (2013) to your library and it's now searching.", timestamp: '' },
  ];
  let nextId = 800;
  const stub = installFetchStub([], {
    lookupByTerm: { 'Despicable Me': [
      dmCollection('Despicable Me', 2010, 20352, 514, true),   // already in library + file
      dmCollection('Despicable Me 2', 2013, 93456, 515, true), // already in library + file
      dmCollection('Despicable Me 3', 2017, 324852, 0, false), // not added
      dmCollection('Despicable Me 4', 2024, 519182, 0, false), // not added
    ] },
    onAdd: (b) => ({ id: nextId++, title: b.title, tmdbId: b.tmdbId }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'Get 3 and 4 as well', [], hist);
    assert.match(r.response, /Despicable Me 3 \(2017\)/);
    assert.match(r.response, /Despicable Me 4 \(2024\)/);
    assert.doesNotMatch(r.response, /Despicable Me \(2010\)/, 'DM1 was not requested');
    assert.doesNotMatch(r.response, /Despicable Me 2 \(2013\)/, 'DM2 was not requested');
    assert.equal([...r.response.matchAll(/<!--JOB:movie:\d+:/g)].length, 2, 'two films grabbed');
  } finally {
    stub.restore();
  }
});

test('net A — never trusts a model id: uses the collection lookup id even though the model never spoke', async () => {
  // The point of A/B: no model turn happens at all (handler runs pre-loop), so a hallucinated id like
  // 356894 ("We Are the Littletons") can never sneak in — the JOB ids come only from onAdd/library.
  let nextId = 900;
  const stub = installFetchStub([], {
    lookupByTerm: { 'Despicable Me': [
      dmCollection('Despicable Me 3', 2017, 324852, 0, false),
      dmCollection('Despicable Me 4', 2024, 519182, 0, false),
    ] },
    onAdd: (b) => ({ id: nextId++, title: b.title, tmdbId: b.tmdbId }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'get 3 and 4', [], [
      { role: 'assistant', text: 'Added Despicable Me 2 (2013).', timestamp: '' },
    ]);
    assert.doesNotMatch(r.response, /356894/);
    assert.match(r.response, /Despicable Me 3/);
    const calls = stub.calls();
    assert.ok(!calls.some(c => c.includes('/api/chat')), 'the model was never called — fully deterministic');
  } finally {
    stub.restore();
  }
});

test('multi-add guard — a STATUS query with numbers ("are 3 and 4 here yet?") does NOT add anything', async () => {
  // The handler must defer to the status path, never trigger adds on a status check.
  const hist = [{ role: 'assistant', text: 'Added Despicable Me 2 (2013).', timestamp: '' }];
  const stub = installFetchStub([{ content: 'Despicable Me 3 is still downloading.' }], {
    lookupByTerm: { 'Despicable Me': [
      dmCollection('Despicable Me 3', 2017, 324852, 0, false),
      dmCollection('Despicable Me 4', 2024, 519182, 0, false),
    ] },
  });
  try {
    const r = await runLocalSession('+15551234567', 'how are 3 and 4 doing?', [], hist);
    const calls = stub.calls();
    assert.ok(!calls.some(c => c.startsWith('POST') && c.includes('/movie')), 'must NOT add a movie on a status query');
    assert.equal([...r.response.matchAll(/<!--JOB:/g)].length, 0, 'no jobs registered on a status query');
  } finally {
    stub.restore();
  }
});

test('net C — unresolvable multi-item request → graceful guidance, not a dead-end "try again"', async () => {
  // "all the foobar movies": search returns nothing → no collection → handler bails to the model loop,
  // which thrashes to hop exhaustion. C must reply with guidance, never the dead-end retry message.
  const stub = installFetchStub([tc('search_movie', { query: 'foobar' })], {
    lookupByTerm: { foobar: [] },
  });
  try {
    const r = await runLocalSession('+15551234567', 'get all the foobar movies', []);
    assert.match(r.response, /one at a time/i, 'should guide the user');
    assert.doesNotMatch(r.response, /give it another try/i, 'must not dead-end');
  } finally {
    stub.restore();
  }
});

// --- Always-search-both + cross-type (movie ⇄ TV) disambiguation (2026-06-16) -------------------
// Jeff's ask: for a bare title, search BOTH Radarr and Sonarr; when it matches a dominant movie AND a
// dominant show, present a numbered choice (don't auto-pick); after the user picks, add the movie /
// short show or ask seasons for a long show. A single dominant match proceeds straight through.

test('cross-type: bare title that is BOTH a movie and a show → searches both, presents a numbered choice, adds nothing', async () => {
  const movieResults = [{ tmdbId: 50001, title: 'The Outsider', year: 2018, id: 0, popularity: 12 }];
  const tvResults = [{ tvdbId: 60001, title: 'The Outsider', year: 2020, id: 0, popularity: 11,
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }] }];
  // No model turns are needed — the deterministic handler answers BEFORE the loop. (A fallback turn
  // is provided in case the handler ever fell through, so the test fails loudly rather than hanging.)
  const turns: Turn[] = [{ content: 'FALLBACK — handler should have answered' }];
  const stub = installCrossTypeFetchStub(turns, {
    radarrByTerm: { 'The Outsider': movieResults },
    sonarrByTerm: { 'The Outsider': tvResults },
  });
  try {
    const r = await runLocalSession('+15551234567', 'can you get The Outsider', []);
    assert.equal(r.job, undefined, 'must NOT add anything — the user has to pick first');
    assert.match(r.response, /which one/i, 'should present a choice');
    assert.match(r.response, /1\./, 'numbered option 1');
    assert.match(r.response, /2\./, 'numbered option 2');
    assert.match(r.response, /movie/i);
    assert.match(r.response, /tv show/i);
    assert.doesNotMatch(r.response, /FALLBACK/, 'the deterministic handler must answer, not the model');
    const calls = stub.calls();
    assert.ok(calls.some(c => c.includes('/movie/lookup')), 'BOTH types searched: movie');
    assert.ok(calls.some(c => c.includes('/series/lookup')), 'BOTH types searched: TV');
    assert.equal(calls.filter(c => c.startsWith('POST')).length, 0, 'no add POST before a pick');
  } finally {
    stub.restore();
  }
});

test('cross-type pick: user picks the MOVIE from a prior choice list → adds the movie', async () => {
  const movieResults = [{ tmdbId: 50001, title: 'The Outsider', year: 2018, id: 0, popularity: 12 }];
  const tvResults = [{ tvdbId: 60001, title: 'The Outsider', year: 2020, id: 0, popularity: 11,
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }] }];
  const choiceList = '1. The Outsider (2018) — movie\n2. The Outsider (2020) — TV show';
  const turns: Turn[] = [{ content: 'FALLBACK — handler should have answered' }];
  const stub = installCrossTypeFetchStub(turns, {
    radarrByTerm: { 'The Outsider': movieResults },
    radarrByTmdb: { 50001: [{ tmdbId: 50001, title: 'The Outsider', year: 2018 }] },
    sonarrByTerm: { 'The Outsider': tvResults },
    onMovieAdd: (b) => ({ id: 701, title: b.title, tmdbId: b.tmdbId, year: 2018 }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'the movie', [], [
      { role: 'user', text: 'can you get The Outsider', timestamp: 't' },
      { role: 'assistant', text: choiceList, timestamp: 't' },
    ]);
    assert.ok(r.job, 'should add the chosen movie');
    assert.equal(r.job!.type, 'movie');
    assert.equal(r.job!.arrId, 701);
    assert.match(r.response, /Added The Outsider/i);
    assert.doesNotMatch(r.response, /FALLBACK/);
  } finally {
    stub.restore();
  }
});

test('cross-type pick: user picks a LONG show → asks which seasons, adds nothing', async () => {
  const tvResults = [{ tvdbId: 60002, title: 'The Outsider', year: 2020, id: 0, popularity: 11,
    seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }, { seasonNumber: 4 }] }];
  const choiceList = '1. The Outsider (2018) — movie\n2. The Outsider (2020) — TV show';
  const turns: Turn[] = [{ content: 'FALLBACK — handler should have answered' }];
  const stub = installCrossTypeFetchStub(turns, {
    radarrByTerm: { 'The Outsider': [{ tmdbId: 50001, title: 'The Outsider', year: 2018, id: 0 }] },
    sonarrByTerm: { 'The Outsider': tvResults },
  });
  try {
    const r = await runLocalSession('+15551234567', 'the show', [], [
      { role: 'user', text: 'can you get The Outsider', timestamp: 't' },
      { role: 'assistant', text: choiceList, timestamp: 't' },
    ]);
    assert.equal(r.job, undefined, 'a long show must ask seasons before adding');
    assert.match(r.response, /season/i, 'should ask which seasons');
    assert.match(r.response, /The Outsider/i);
    const calls = stub.calls();
    assert.equal(calls.filter(c => /\/series(\?|$)/.test((c.split(' ')[1] || c)) && c.startsWith('POST')).length, 0, 'no series add before a season pick');
  } finally {
    stub.restore();
  }
});

test('cross-type pick: user picks a SHORT show by number → adds all seasons', async () => {
  const tvResults = [{ tvdbId: 60003, title: 'Twisted Metal', year: 2023, id: 0, popularity: 9,
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }] }];
  const choiceList = '1. Twisted Metal (2017) — movie\n2. Twisted Metal (2023) — TV show';
  const turns: Turn[] = [{ content: 'FALLBACK — handler should have answered' }];
  let addBody: any;
  const stub = installCrossTypeFetchStub(turns, {
    radarrByTerm: { 'Twisted Metal': [{ tmdbId: 50009, title: 'Twisted Metal', year: 2017, id: 0 }] },
    sonarrByTerm: { 'Twisted Metal': tvResults },
    sonarrByTvdb: { 60003: tvResults },
    onTvAdd: (b) => { addBody = b; return { id: 702, title: b.title, tvdbId: b.tvdbId, seasons: b.seasons }; },
  });
  try {
    const r = await runLocalSession('+15551234567', '2', [], [
      { role: 'user', text: 'can you get Twisted Metal', timestamp: 't' },
      { role: 'assistant', text: choiceList, timestamp: 't' },
    ]);
    assert.ok(r.job, 'should add the chosen short show');
    assert.equal(r.job!.type, 'tv');
    assert.equal(r.job!.arrId, 702);
    assert.match(r.response, /Added Twisted Metal/i);
    assert.match(r.response, /all seasons/i);
  } finally {
    stub.restore();
  }
});

test('cross-type: a SINGLE dominant match (movie only) → NO disambiguation, falls through to the normal add', async () => {
  // Inception is a dominant movie and NOT a show. The handler searches both, finds only one dominant
  // candidate, and falls through to the model loop — which adds it straight through (no choice list).
  const movieResults = [{ tmdbId: 27205, title: 'Inception', year: 2010, id: 0, popularity: 30 }];
  const turns: Turn[] = [
    tc('search_movie', { query: 'Inception' }),
    { content: 'I found Inception (2010). Which one did you mean?' },   // needless ask → net #8 forces add
    tc('add_movie', { tmdb_id: 27205, title: 'Inception' }),
    { content: 'Done — Inception (2010) is downloading now.' },
  ];
  const stub = installCrossTypeFetchStub(turns, {
    radarrByTerm: { Inception: movieResults },
    radarrByTmdb: { 27205: [{ tmdbId: 27205, title: 'Inception', year: 2010 }] },
    sonarrByTerm: { Inception: [] },                                     // not a show
    onMovieAdd: (b) => ({ id: 705, title: b.title, tmdbId: b.tmdbId, year: 2010 }),
  });
  try {
    const r = await runLocalSession('+15551234567', 'get Inception', []);
    assert.ok(r.job, 'a single dominant match should be added straight through');
    assert.equal(r.job!.arrId, 705);
    assert.doesNotMatch(r.response, /which one do you want/i, 'must NOT present a cross-type choice for a single dominant match');
    const calls = stub.calls();
    assert.ok(calls.some(c => c.includes('/movie/lookup')), 'movie searched');
    assert.ok(calls.some(c => c.includes('/series/lookup')), 'TV searched too (always-search-both)');
  } finally {
    stub.restore();
  }
});
