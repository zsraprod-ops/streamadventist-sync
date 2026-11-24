
import { writeFile, rename } from 'node:fs/promises';

const {
  YOUTUBE_API_KEY,
  WIX_API_KEY,
  WIX_SITE_ID,
  WIX_COLLECTION
} = process.env;

if (!YOUTUBE_API_KEY || !WIX_API_KEY || !WIX_SITE_ID) {
  throw new Error('Secrets manquants');
}

async function wixQuery(offset) {
  const response = await fetch(
    'https://www.wixapis.com/wix-data/v2/items/query',
    {
      method: 'POST',
      headers: {
        Authorization: WIX_API_KEY,
        'wix-site-id': WIX_SITE_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        dataCollectionId: WIX_COLLECTION,
        query: {
          paging: { limit: 100, offset },
          sort: [{ fieldName: '_id', order: 'ASC' }]
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Wix HTTP ${response.status}`);
  }

  return response.json();
}

async function readSources() {
  const records = [];

  for (let offset = 0; ; offset += 100) {
    const result = await wixQuery(offset);
    const page = result.dataItems;

    if (!Array.isArray(page)) {
      throw new Error('Catalogue Wix invalide');
    }

    records.push(...page.map(item => item.data));

    if (page.length < 100) break;
  }

  return records;
}

async function youtube(endpoint, params) {
  const url = new URL(
    `https://www.googleapis.com/youtube/v3/${endpoint}`
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  url.searchParams.set('key', YOUTUBE_API_KEY);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`YouTube HTTP ${response.status}`);
  }

  return response.json();
}

async function allPages(endpoint, params) {
  const items = [];
  const seen = new Set();
  let token;

  do {
    const result = await youtube(endpoint, {
      ...params,
      maxResults: 50,
      ...(token ? { pageToken: token } : {})
    });

    if (!Array.isArray(result.items)) {
      throw new Error('Réponse YouTube invalide');
    }

    items.push(...result.items);
    token = result.nextPageToken;

    if (token && seen.has(token)) {
      throw new Error('Pagination invalide');
    }

    if (token) seen.add(token);
  } while (token);

  return items;
}

const newest = (a, b) =>
  (Date.parse(b.publishedAt) || 0) -
  (Date.parse(a.publishedAt) || 0);

async function resolveChannel(source) {
  const params = { part: 'snippet,contentDetails' };

  if (/^UC[\w-]{22}$/.test(source.channelId || '')) {
    params.id = source.channelId;
  } else {
    const url = new URL(source.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0]?.startsWith('@')) {
      params.forHandle = parts[0];
    } else if (parts[0] === 'channel') {
      params.id = parts[1];
    } else if (parts[0] === 'user') {
      params.forUsername = parts[1];
    } else {
      throw new Error('Adresse de chaîne non reconnue');
    }
  }

  const result = await youtube('channels', params);

  if (!result.items?.length) {
    throw new Error('Chaîne introuvable');
  }

  return result.items[0];
}

function playlistId(source) {
  try {
    return new URL(source.url).searchParams.get('list')
      || source.id;
  } catch {
    return source.id;
  }
}

const records = await readSources();
const channels = new Map();
const playlists = new Map();
const existingPlaylists = new Map();

for (const row of records) {
  if (row.kind === 'playlist' && row.payload) {
    existingPlaylists.set(
      playlistId(row.payload),
      row.payload
    );
  }
}

for (const row of records) {
  if (!row.payload) continue;

  if (row.kind === 'channel') {
    const channel = await resolveChannel(row.payload);

    channels.set(channel.id, {
      ...row.payload,
      channelId: channel.id,
      name: channel.snippet.title,
      playlists: []
    });

    const found = await allPages('playlists', {
      part: 'snippet,contentDetails,status',
      channelId: channel.id
    });

    for (const playlist of found) {
      if (playlist.status?.privacyStatus === 'public') {
        playlists.set(playlist.id, playlist);
      }
    }
  }
}

const ids = [...existingPlaylists.keys()].filter(Boolean);

for (let i = 0; i < ids.length; i += 50) {
  const result = await youtube('playlists', {
    part: 'snippet,contentDetails,status',
    id: ids.slice(i, i + 50).join(',')
  });

  for (const playlist of result.items || []) {
    if (playlist.status?.privacyStatus === 'public') {
      playlists.set(playlist.id, playlist);
    }
  }
}

if (!channels.size && !playlists.size) {
  throw new Error('Aucune source disponible');
}

const catalogue = [];

for (const playlist of playlists.values()) {
  const items = await allPages('playlistItems', {
    part: 'snippet,contentDetails,status',
    playlistId: playlist.id
  });

  const videoIds = [...new Set(
    items.map(item => item.contentDetails?.videoId)
      .filter(Boolean)
  )];

  const videos = [];

  for (let i = 0; i < videoIds.length; i += 50) {
    const result = await youtube('videos', {
      part: 'snippet,status',
      id: videoIds.slice(i, i + 50).join(',')
    });

    for (const video of result.items || []) {
      if (video.status?.privacyStatus !== 'public') continue;

      const s = video.snippet;

      videos.push({
        id: video.id,
        title: s.title,
        publishedAt: s.publishedAt || '',
        image: s.thumbnails?.high?.url ||
          s.thumbnails?.medium?.url ||
          `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${video.id}`
      });
    }
  }

  videos.sort(newest);

  const entry = {
    ...existingPlaylists.get(playlist.id),
    id: playlist.id,
    channelId: playlist.snippet.channelId,
    name: playlist.snippet.title,
    description: playlist.snippet.description,
    image: playlist.snippet.thumbnails?.high?.url ||
      playlist.snippet.thumbnails?.medium?.url || '',
    url: `https://www.youtube.com/playlist?list=${playlist.id}`,
    publishedAt: videos[0]?.publishedAt || '',
    count: videos.length,
    videos
  };

  catalogue.push(entry);

  const channel = channels.get(entry.channelId);
  if (channel) channel.playlists.push(entry);

  console.log(`${entry.name}: ${entry.count} vidéos`);
}

for (const channel of channels.values()) {
  channel.playlists.sort(newest);
}

await writeFile(
  'catalogue.tmp',
  JSON.stringify({
    channels: [...channels.values()],
    playlists: catalogue.sort(newest)
  }, null, 2)
);

await rename('catalogue.tmp', 'catalogue.json');

console.log(
  `Synchronisation terminée : ${channels.size} chaînes, ` +
  `${playlists.size} playlists`
);
