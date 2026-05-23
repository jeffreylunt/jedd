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
