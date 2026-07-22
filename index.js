#!/usr/bin/env node
// =============================================================================
// Daily Drive — Main Script (Feb 2026 API compatible)
// =============================================================================

const fs = require("fs");
const yaml = require("js-yaml");
const SpotifyWebApi = require("spotify-web-api-node");

const TOKEN_FILE = ".spotify-token.json";
const CONFIG_FILE = "config.yaml";
const STATE_FILE = "state.json";
const ARTIST_POOL_FILE = "artist-pool.json";
const ARTIST_POOL_MAX = 500;
const HEARD_TRACKS_FILE = "heard-tracks.json";
const HEARD_TRACKS_MAX = 3000;

const DRY_RUN = process.argv.includes("--dry-run");
const PODCAST_ONLY = process.argv.includes("--podcast-only");

// =============================================================================
// Helper Functions
// =============================================================================

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("❌ config.yaml not found! Run: cp config.example.yaml config.yaml");
    process.exit(1);
  }
  return yaml.load(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error("❌ Not authenticated! Run: npm run setup");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
}

function saveToken(tokenData) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function refreshTokenIfNeeded(spotifyApi, token) {
  if (Date.now() > token.expires_at - 5 * 60 * 1000) {
    console.log("🔄 Refreshing access token...");
    const data = await spotifyApi.refreshAccessToken();
    token.access_token = data.body.access_token;
    token.expires_at = Date.now() + data.body.expires_in * 1000;
    if (data.body.refresh_token) token.refresh_token = data.body.refresh_token;
    saveToken(token);
    spotifyApi.setAccessToken(token.access_token);
    console.log("✅ Token refreshed");
  }
}

async function spotifyFetch(spotifyApi, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${spotifyApi.getAccessToken()}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function loadHeardTracks() {
  if (!fs.existsSync(HEARD_TRACKS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(HEARD_TRACKS_FILE, "utf8")); }
  catch { return []; }
}

function saveHeardTracks(heard) {
  while (heard.length > HEARD_TRACKS_MAX) heard.shift();
  fs.writeFileSync(HEARD_TRACKS_FILE, JSON.stringify(heard, null, 2));
}

// =============================================================================
// Artist Pool — persistent, FIFO, max 500
// =============================================================================

function loadArtistPool() {
  if (!fs.existsSync(ARTIST_POOL_FILE)) {
    return { artists: [], last_updated: null };
  }
  try { return JSON.parse(fs.readFileSync(ARTIST_POOL_FILE, "utf8")); }
  catch { return { artists: [], last_updated: null }; }
}

function saveArtistPool(pool) {
  pool.last_updated = new Date().toISOString();
  fs.writeFileSync(ARTIST_POOL_FILE, JSON.stringify(pool, null, 2));
}

function addToPool(pool, artistId, artistName) {
  const existingIdx = pool.artists.findIndex((a) => a.id === artistId);
  if (existingIdx !== -1) {
    const existing = pool.artists.splice(existingIdx, 1)[0];
    existing.refreshed = new Date().toISOString();
    pool.artists.push(existing);
    return false;
  }

  pool.artists.push({
    id: artistId,
    name: artistName,
    added: new Date().toISOString(),
  });

  while (pool.artists.length > ARTIST_POOL_MAX) {
    const removed = pool.artists.shift();
    console.log(`    🗑️  Pool full — evicted oldest: ${removed.name}`);
  }

  return true;
}

// =============================================================================
// Podcast Logic — skip fully-played episodes
// =============================================================================

async function fetchPodcastEpisodes(spotifyApi, podcasts) {
  const episodes = [];

  for (const podcast of podcasts) {
    const count = podcast.episodes || 1;
    const mode = podcast.mode || "newest";

    console.log(`🎙️  Fetching ${count} episode(s) from: ${podcast.name} (mode: ${mode})`);

    try {
      if (mode === "oldest_unplayed") {
        const scanLimit = podcast.scan_limit || 50;
        const batchSize = 50;
        let offset = 0;
        let scanned = 0;
        const unplayed = [];

        while (scanned < scanLimit) {
          const limit = Math.min(batchSize, scanLimit - scanned);
          const data = await spotifyApi.getShowEpisodes(podcast.id, {
            limit, offset, market: "US",
          });
          const items = data.body.items;
          if (items.length === 0) break;

          for (const ep of items) {
            const status = ep.resume_point?.fully_played ? "✅ played" : "⬜ unplayed";
            console.log(`    ${status}  ${ep.name}`);
            if (!ep.resume_point?.fully_played) unplayed.push(ep);
          }

          scanned += items.length;
          offset += items.length;
          if (items.length < limit) break;
          console.log(`    📊 Scanned ${scanned}/${scanLimit}, ${unplayed.length} unplayed`);
        }

        console.log(`    📊 Scan complete: ${scanned} scanned, ${unplayed.length} unplayed`);
        unplayed.reverse();

        if (unplayed.length === 0) {
          console.log(`    ⏭️  All episodes fully played — skipping "${podcast.name}"`);
          continue;
        }

        for (const episode of unplayed.slice(0, count)) {
          episodes.push({
            uri: episode.uri, name: episode.name,
            show: podcast.name, type: "episode",
            position: podcast.position || null,
          });
          console.log(`    📌 Selected: ${episode.name}`);
        }
      } else {
        const data = await spotifyApi.getShowEpisodes(podcast.id, {
          limit: count + 5, market: "US",
        });

        let added = 0;
        for (const episode of data.body.items) {
          if (added >= count) break;
          if (episode.resume_point?.fully_played) {
            console.log(`    ⏭️  Skipping fully played: ${episode.name}`);
            continue;
          }
          episodes.push({
            uri: episode.uri, name: episode.name,
            show: podcast.name, type: "episode",
            position: podcast.position || null,
          });
          console.log(`    📌 ${episode.name}`);
          added++;
        }
        if (added === 0) {
          console.log(`    ⏭️  All recent episodes fully played — skipping "${podcast.name}"`);
        }
      }
    } catch (err) {
      console.error(`    ⚠️  Failed to fetch ${podcast.name}: ${err.message}`);
    }
  }

  return episodes;
}

// =============================================================================
// Music — Familiar Pool (playlists + top tracks)
// =============================================================================

async function fetchMusicPool(spotifyApi, musicConfig) {
  let allTracks = [];

  if (musicConfig.playlists) {
    for (const playlist of musicConfig.playlists) {
      if (!playlist.id || playlist.id === "your-playlist-id") continue;
      console.log(`🎵 Fetching playlist: ${playlist.name}`);
      try {
        let offset = 0;
        let hasMore = true;
        while (hasMore) {
          const data = await spotifyFetch(spotifyApi,
            `https://api.spotify.com/v1/playlists/${playlist.id}/items?limit=100&offset=${offset}`
          );
          for (const entry of data.items) {
            const track = entry.item;
            if (track && track.uri && track.type === "track") {
              allTracks.push({
                uri: track.uri, name: track.name,
                artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
                artistIds: track.artists?.map((a) => a.id).filter(Boolean) || [],
                artistNames: track.artists?.map((a) => a.name).filter(Boolean) || [],
                type: "track",
              });
            }
          }
          offset += 100;
          hasMore = offset < data.total;
        }
        console.log(`    ${allTracks.length} tracks so far`);
      } catch (err) {
        console.error(`    ⚠️  Failed: ${err.message}`);
      }
    }
  }

  if (musicConfig.top_tracks?.enabled) {
    const timeRange = musicConfig.top_tracks.time_range || "short_term";
    const count = musicConfig.top_tracks.count || 30;
    console.log(`🎵 Fetching top tracks (${timeRange})...`);
    try {
      let offset = 0;
      let remaining = count;
      while (remaining > 0) {
        const limit = Math.min(remaining, 50);
        const data = await spotifyApi.getMyTopTracks({ limit, offset, time_range: timeRange });
        for (const track of data.body.items) {
          allTracks.push({
            uri: track.uri, name: track.name,
            artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
            artistIds: track.artists?.map((a) => a.id).filter(Boolean) || [],
            artistNames: track.artists?.map((a) => a.name).filter(Boolean) || [],
            type: "track",
          });
        }
        if (data.body.items.length < limit) break;
        offset += limit;
        remaining -= limit;
      }
    } catch (err) {
      console.error(`    ⚠️  Failed: ${err.message}`);
    }
  }

  const seen = new Set();
  allTracks = allTracks.filter((t) => {
    if (seen.has(t.uri)) return false;
    seen.add(t.uri);
    return true;
  });

  console.log(`🎵 Track pool: ${allTracks.length} unique tracks`);
  return allTracks;
}

// =============================================================================
// Artist Pool Growth — Saved Tracks + appears_on + featured artists
// =============================================================================

async function seedPoolFromSavedTracks(spotifyApi, pool) {
  console.log(`🌱 Seeding artist pool from saved tracks...`);
  let added = 0;

  try {
    let offset = 0;
    const maxToFetch = 200;

    while (offset < maxToFetch) {
      const limit = Math.min(50, maxToFetch - offset);
      const data = await spotifyApi.getMySavedTracks({ limit, offset, market: "US" });

      for (const entry of data.body.items) {
        const track = entry.track;
        if (!track) continue;
        for (const artist of track.artists || []) {
          if (artist.id && addToPool(pool, artist.id, artist.name)) {
            added++;
          }
        }
      }

      if (data.body.items.length < limit) break;
      offset += limit;
    }
  } catch (err) {
    console.error(`    ⚠️  Failed to fetch saved tracks: ${err.message}`);
  }

  console.log(`    🌱 Added ${added} new artists from saved tracks (pool: ${pool.artists.length})`);
}

async function expandPool(spotifyApi, pool, artistsToMine) {
  console.log(`⛏️  Expanding pool — mining ${artistsToMine} random artists for co-artists...`);

  const candidates = shuffle(pool.artists).slice(0, artistsToMine);
  let newArtists = 0;

  for (const entry of candidates) {
    try {
      const albumData = await spotifyApi.getArtistAlbums(entry.id, {
        limit: 20,
        include_groups: "appears_on,album,single",
      });

      const albums = albumData.body.items;

      for (const album of albums) {
        for (const albumArtist of album.artists || []) {
          if (albumArtist.id && albumArtist.id !== entry.id) {
            if (addToPool(pool, albumArtist.id, albumArtist.name)) {
              newArtists++;
            }
          }
        }
      }

      if (albums.length > 0) {
        const randomAlbum = albums[Math.floor(Math.random() * albums.length)];
        try {
          const trackData = await spotifyApi.getAlbumTracks(randomAlbum.id, { limit: 50 });
          for (const track of trackData.body.items) {
            for (const artist of track.artists || []) {
              if (artist.id && artist.id !== entry.id) {
                if (addToPool(pool, artist.id, artist.name)) {
                  newArtists++;
                }
              }
            }
          }
        } catch (err) { /* non-critical */ }
      }

      await delay(50);
    } catch (err) {
      console.error(`    ⚠️  Mining failed for ${entry.name}: ${err.message}`);
    }
  }

  console.log(`    ⛏️  Discovered ${newArtists} new co-artists/features (pool: ${pool.artists.length})`);
}

// =============================================================================
// Discovery — fetch tracks from pool artists, filter aggressively
// =============================================================================

async function fetchSmartDiscovery(spotifyApi, poolTracks, artistPool, count) {
  console.log(`🔍 Discovering ${count} tracks from artist pool (${artistPool.artists.length} artists)...`);

  const poolUris = new Set(poolTracks.map((t) => t.uri));
  const candidates = [];

  // ── Exclusion set 1: recently played ──
  const recentUris = new Set();
  try {
    const recent = await spotifyApi.getMyRecentlyPlayedTracks({ limit: 50 });
    for (const item of recent.body.items) recentUris.add(item.track.uri);
    console.log(`    📜 Excluding ${recentUris.size} recently played`);
  } catch (err) {
    console.error(`    ⚠️  Could not fetch recently played: ${err.message}`);
  }

  // ── Exclusion set 2: previously heard discovery tracks ──
  const heardTracks = loadHeardTracks();
  const heardUris = new Set(heardTracks.map((h) => h.uri));
  console.log(`    🔇 Excluding ${heardUris.size} previously heard discovery tracks`);

  // ── Mine random pool artists ──
  const shuffledArtists = shuffle(artistPool.artists);
  const maxToMine = Math.min(shuffledArtists.length, 20);
  const minedAlbums = new Set();

  for (let i = 0; i < maxToMine; i++) {
    if (candidates.length >= count * 4) break;

    const artist = shuffledArtists[i];

    try {
      const albumData = await spotifyApi.getArtistAlbums(artist.id, {
        limit: 10,
        include_groups: "album,single",
      });

      const albums = albumData.body.items.filter((a) => !minedAlbums.has(a.id));
      if (albums.length === 0) continue;

      const picks = shuffle(albums).slice(0, 2);

      for (const album of picks) {
        minedAlbums.add(album.id);

        const trackData = await spotifyApi.getAlbumTracks(album.id, { limit: 50 });

        for (const track of trackData.body.items) {
          if (track.duration_ms < 65000) continue;                    // too short
          if (poolUris.has(track.uri)) continue;                      // already familiar
          if (recentUris.has(track.uri)) continue;                    // recently played
          if (heardUris.has(track.uri)) continue;                     // previously heard
          if (candidates.some((c) => c.uri === track.uri)) continue;  // dupe

          candidates.push({
            uri: track.uri,
            name: track.name,
            artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
            durationMs: track.duration_ms,
            albumName: album.name,
            type: "track",
            source: "discovery",
          });
        }
      }

      if ((i + 1) % 5 === 0) {
        console.log(`    ⛏️  ${i + 1}/${maxToMine} artists → ${candidates.length} candidates`);
      }

      await delay(50);
    } catch (err) {
      console.error(`    ⚠️  Mining failed for ${artist.name}: ${err.message}`);
    }
  }

  console.log(`    ⛏️  Mining done: ${candidates.length} candidates from ${minedAlbums.size} albums`);

  // ── Library check via GET /me/library/contains ──
  const filtered = [];
  const accessToken = spotifyApi.getAccessToken();

  for (let i = 0; i < candidates.length; i += 50) {
    const batch = candidates.slice(i, i + 50);
    const uris = batch.map((t) => t.uri);

    try {
      const queryString = uris.map((u) => encodeURIComponent(u)).join(",");
      const res = await fetch(
        `https://api.spotify.com/v1/me/library/contains?uris=${queryString}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (res.ok) {
        const data = await res.json();
        for (let j = 0; j < batch.length; j++) {
          if (!data[j]) filtered.push(batch[j]);
        }
      } else {
        const ids = batch.map((t) => t.uri.replace("spotify:track:", ""));
        const idRes = await fetch(
          `https://api.spotify.com/v1/me/library/contains?ids=${ids.join(",")}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (idRes.ok) {
          const data = await idRes.json();
          for (let j = 0; j < batch.length; j++) {
            if (!data[j]) filtered.push(batch[j]);
          }
        } else {
          console.error(`    ⚠️  Library check failed (${res.status} / ${idRes.status}) — including all`);
          filtered.push(...batch);
        }
      }
    } catch (err) {
      console.error(`    ⚠️  Library check error: ${err.message}`);
      filtered.push(...batch);
    }
  }

  // ── Max 1 song per artist ──
  const shuffled = shuffle(filtered);
  const selected = [];
  const usedArtistIds = new Set();

  for (const track of shuffled) {
    if (selected.length >= count) break;
    const primaryArtist = track.artist.split(",")[0].trim();
    if (usedArtistIds.has(primaryArtist)) continue;
    usedArtistIds.add(primaryArtist);
    selected.push(track);
  }

  console.log(`🔍 Discovery: ${candidates.length} candidates → ${filtered.length} not in library → ${selected.length} selected`);
  for (const track of selected) {
    console.log(`    🆕 ${track.name} — ${track.artist} (${Math.round(track.durationMs / 1000)}s)`);
  }

  return selected;
}

// =============================================================================
// Mix + Playlist Update
// =============================================================================

function mixContent(episodes, tracks, pattern) {
  const mixed = [];
  let episodeIndex = 0;
  let trackIndex = 0;
  let patternIndex = 0;
  const mixPattern = pattern || "PMMM";

  while (episodeIndex < episodes.length || trackIndex < tracks.length) {
    const slot = mixPattern[patternIndex % mixPattern.length];

    if (slot === "P" || slot === "p") {
      if (episodeIndex < episodes.length) mixed.push(episodes[episodeIndex++]);
    } else {
      if (trackIndex < tracks.length) mixed.push(tracks[trackIndex++]);
    }

    patternIndex++;

    if (episodeIndex >= episodes.length && trackIndex < tracks.length) {
      while (trackIndex < tracks.length) mixed.push(tracks[trackIndex++]);
      break;
    }
    if (trackIndex >= tracks.length && episodeIndex < episodes.length) {
      while (episodeIndex < episodes.length) mixed.push(episodes[episodeIndex++]);
      break;
    }
  }

  return mixed;
}

async function updatePlaylist(spotifyApi, playlistId, items) {
  const uris = items.map((item) => item.uri);

  if (DRY_RUN) {
    console.log("\n🧪 DRY RUN — would update playlist with:\n");
    items.forEach((item, i) => {
      const icon = item.type === "episode" ? "🎙️ " : "🎵";
      const detail = item.type === "episode"
        ? `[${item.show}] ${item.name}`
        : `${item.name} — ${item.artist}`;
      console.log(`  ${String(i + 1).padStart(2)}. ${icon} ${detail}`);
    });
    console.log(`\n✅ Dry run complete. ${items.length} items would be added.\n`);
    return;
  }

  const accessToken = spotifyApi.getAccessToken();

  const clearRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uris: uris.slice(0, 100) }),
  });
  if (!clearRes.ok) throw new Error(`Failed to update: ${clearRes.status} ${await clearRes.text()}`);

  for (let i = 100; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100);
    const addRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: batch }),
    });
    if (!addRes.ok) throw new Error(`Failed to add batch: ${addRes.status} ${await addRes.text()}`);
  }

  console.log(`\n✅ Playlist updated with ${items.length} items!`);
  console.log(`   🎙️  ${items.filter((i) => i.type === "episode").length} podcast episodes`);
  console.log(`   🎵 ${items.filter((i) => i.type === "track").length} songs\n`);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log(`\n🚗 Daily Drive — ${PODCAST_ONLY ? "Hourly podcast refresh" : "Full playlist rebuild"}...\n`);

  const config = loadConfig();
  const token = loadToken();

  const spotifyApi = new SpotifyWebApi({
    clientId: config.spotify.client_id,
    clientSecret: config.spotify.client_secret,
    redirectUri: config.spotify.redirect_uri,
  });

  spotifyApi.setAccessToken(token.access_token);
  spotifyApi.setRefreshToken(token.refresh_token);
  await refreshTokenIfNeeded(spotifyApi, token);

  if (!config.playlist_id || config.playlist_id === "your-playlist-id-here") {
    console.error("❌ Please set your playlist_id in config.yaml");
    process.exit(1);
  }

  // ── Resolve pending discovery from last run ──
  const state = loadState();

  if (!DRY_RUN && state.pending_discovery?.length > 0) {
    console.log(`🔇 Checking ${state.pending_discovery.length} pending discovery tracks...`);

    const recentlyPlayed = new Set();
    try {
      const params = { limit: 50 };
      if (state.last_updated) {
        params.after = new Date(state.last_updated).getTime();
      }
      const recent = await spotifyApi.getMyRecentlyPlayedTracks(params);
      for (const item of recent.body.items) {
        recentlyPlayed.add(item.track.uri);
      }
    } catch (err) {
      console.error(`    ⚠️  Could not fetch recently played: ${err.message}`);
    }

    const heardTracks = loadHeardTracks();
    const existingHeard = new Set(heardTracks.map((h) => h.uri));
    let confirmed = 0;
    let notPlayed = 0;

    for (const pending of state.pending_discovery) {
      if (recentlyPlayed.has(pending.uri)) {
        if (!existingHeard.has(pending.uri)) {
          heardTracks.push({
            uri: pending.uri,
            name: pending.name,
            artist: pending.artist,
            heard_at: new Date().toISOString(),
          });
          confirmed++;
        }
      } else {
        notPlayed++;
      }
    }

    saveHeardTracks(heardTracks);
    console.log(`    ✅ ${confirmed} confirmed played → heard`);
    console.log(`    🔄 ${notPlayed} not played → remain eligible`);
  }

  // ── Podcasts ──
  const episodes = await fetchPodcastEpisodes(spotifyApi, config.podcasts || []);

  const currentEpisodeUris = episodes.map((e) => e.uri).sort().join(",");
  const previousEpisodeUris = state.episode_uris || "";

  if (!DRY_RUN && PODCAST_ONLY && currentEpisodeUris === previousEpisodeUris && episodes.length > 0) {
    console.log("\n⏭️  No new podcast episodes detected. Playlist unchanged.\n");
    process.exit(0);
  }

  // ── Music ──
  let tracks;

  if (PODCAST_ONLY) {
    if (state.music_tracks?.length > 0) {
      tracks = state.music_tracks;
      console.log(`🎵 Reusing ${tracks.length} saved music tracks from last full refresh`);
    } else {
      console.log("⚠️  No saved music — falling back to full fetch");
      tracks = await fetchAllMusicTracks(spotifyApi, config);
    }
  } else {
    tracks = await fetchAllMusicTracks(spotifyApi, config);
  }

  if (episodes.length === 0 && tracks.length === 0) {
    console.error("❌ No content found! Check config.yaml.");
    process.exit(1);
  }

  // ── Mix ──
  const pinnedFirst = [];
  const mixableEpisodes = [];
  for (const ep of episodes) {
    if (ep.position === "first") pinnedFirst.push(ep);
    else mixableEpisodes.push(ep);
  }

  console.log(`\n🔀 Mixing with pattern: ${config.mix_pattern || "PMMM"}`);
  const mixed = [...pinnedFirst, ...mixContent(mixableEpisodes, tracks, config.mix_pattern)];

  await updatePlaylist(spotifyApi, config.playlist_id, mixed);

  // ── Save state ──
  if (!DRY_RUN) {
    const newState = {
      episode_uris: currentEpisodeUris,
      last_updated: new Date().toISOString(),
    };

    if (PODCAST_ONLY) {
      newState.music_tracks = state.music_tracks || tracks;
      newState.last_full_refresh = state.last_full_refresh || null;
      newState.pending_discovery = state.pending_discovery || [];
    } else {
      newState.music_tracks = tracks;
      newState.last_full_refresh = new Date().toISOString();
      // Save discovery tracks as pending — only confirmed-played become "heard"
      newState.pending_discovery = mixed
        .filter((i) => i.source === "discovery")
        .map((i) => ({ uri: i.uri, name: i.name, artist: i.artist }));
      console.log(`🔇 ${newState.pending_discovery.length} discovery tracks saved as pending`);
    }

    saveState(newState);
    console.log("💾 State saved");
  }
}

/**
 * Full music pipeline: familiar pool + artist pool growth + discovery mining.
 */
async function fetchAllMusicTracks(spotifyApi, config) {
  const musicConfig = config.music || {};
  const totalSongs = musicConfig.total_songs || 15;
  const familiarCount = Math.ceil(totalSongs / 2);
  const discoveryCount = totalSongs - familiarCount;

  const pool = await fetchMusicPool(spotifyApi, musicConfig);

  const artistPool = loadArtistPool();
  const poolSizeBefore = artistPool.artists.length;

  await seedPoolFromSavedTracks(spotifyApi, artistPool);

  for (const track of pool) {
    for (let k = 0; k < (track.artistIds?.length || 0); k++) {
      addToPool(artistPool, track.artistIds[k], track.artistNames?.[k] || "Unknown");
    }
  }

  if (artistPool.artists.length > 0) {
    await expandPool(spotifyApi, artistPool, 10);
  }

  console.log(`🎨 Artist pool: ${poolSizeBefore} → ${artistPool.artists.length}`);

  saveArtistPool(artistPool);
  console.log("💾 Artist pool saved");

  // Step 3+4: Fill total_songs — flexible split, 1 per artist, backfill
  const targetTotal = musicConfig.total_songs || 15;
  const familiarTarget = Math.ceil(targetTotal / 2);

  // Familiar: max 1 song per artist
  let familiar = musicConfig.shuffle !== false ? shuffle(pool) : [...pool];
  const familiarFiltered = [];
  const familiarArtists = new Set();
  for (const track of familiar) {
    if (familiarFiltered.length >= familiarTarget) break;
    const primaryArtist = track.artistIds?.[0] || track.artist;
    if (familiarArtists.has(primaryArtist)) continue;
    familiarArtists.add(primaryArtist);
    familiarFiltered.push(track);
  }
  familiar = familiarFiltered;
  console.log(`🎵 Selected ${familiar.length} familiar tracks (target: ${familiarTarget})`);

  // Discovery gets remaining slots (if familiar fell short, discovery gets more)
  const discoveryTarget = targetTotal - familiar.length;
  let discovery = [];
  if (discoveryTarget > 0 && artistPool.artists.length > 0) {
    discovery = await fetchSmartDiscovery(spotifyApi, pool, artistPool, discoveryTarget);
  }

  // Backfill: if discovery fell short, allow 2nd song per artist from familiar
  const currentTotal = familiar.length + discovery.length;
  if (currentTotal < targetTotal) {
    const backfillNeeded = targetTotal - currentTotal;
    const usedUris = new Set([...familiar, ...discovery].map((t) => t.uri));
    let backfilled = 0;
    const reshuffled = musicConfig.shuffle !== false ? shuffle(pool) : [...pool];
    for (const track of reshuffled) {
      if (backfilled >= backfillNeeded) break;
      if (usedUris.has(track.uri)) continue;
      usedUris.add(track.uri);
      familiar.push(track);
      backfilled++;
    }
    if (backfilled > 0) {
      console.log(`🎵 Backfilled ${backfilled} extra familiar tracks to reach target`);
    }
  }

  const tracks = [...familiar, ...discovery];
  console.log(`🎵 Music total: ${familiar.length} familiar + ${discovery.length} discovery = ${tracks.length} (target: ${targetTotal})`);
  return tracks;
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  if (err.statusCode === 401) {
    console.error("   Token expired? Run: npm run setup\n");
  }
  process.exit(1);
});