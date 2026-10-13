
const WORKER =
  "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";

const PAGE_SIZE = 100;
const MAX_WORKER_PAGES = 127;
const CACHE_MS = 60_000;
const pageCache = new Map();
const itemCache = new Map();

const KIND = {
  ctg_movies: "movies",
  ctg_tv: "tv",
  ctg_anime: "anime",
};

const manifest = {
  id: "com.ctgmovies.d1addon",
  version: "1.0.0",
  name: "CTGMovies D1",
  description:
    "CTGMovies catalog powered by Cloudflare D1",
  resources: [
    "catalog",
    {
      name: "meta",
      types: ["movie", "series"],
      idPrefixes: ["ctg:"],
    },
    {
      name: "stream",
      types: ["movie", "series"],
      idPrefixes: ["ctg:"],
    },
  ],
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "ctg_movies",
      name: "CTGMovies Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "ctg_tv",
      name: "CTGMovies TV Shows",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "ctg_anime",
      name: "CTGMovies Anime",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
  ],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};

function parseJSON(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalize(item) {
  if (!item) return null;

  return {
    ...item,
    genres: parseJSON(item.genres, []),
    episodes: parseJSON(item.episodes, []),
    links: parseJSON(item.links, []),
  };
}

async function workerJSON(path, timeout = 9000) {
  const response = await fetch(WORKER + path, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    throw new Error(`Worker HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.ok === false) {
    throw new Error(data.error || "Worker API error");
  }

  return data;
}

async function getPage(page) {
  const key = `page:${page}`;
  const cached = pageCache.get(key);

  if (cached && Date.now() - cached.time < CACHE_MS) {
    return cached.items;
  }

  const data = await workerJSON(
    `/movies?page=${page}`
  );

  const items = (data.items || [])
    .map(normalize)
    .filter(Boolean);

  pageCache.set(key, {
    time: Date.now(),
    items,
  });

  return items;
}

async function getItem(id) {
  if (itemCache.has(id)) {
    const cached = itemCache.get(id);

    if (Date.now() - cached.time < CACHE_MS) {
      return cached.item;
    }
  }

  const data = await workerJSON(
    `/meta?id=${encodeURIComponent(id)}`
  );

  const item = normalize(data.meta);

  if (item) {
    itemCache.set(id, {
      time: Date.now(),
      item,
    });
  }

  return item;
}

function stremioType(kind) {
  return kind === "movies" ? "movie" : "series";
}

function catalogCard(item) {
  return {
    id: item.id,
    type: stremioType(item.kind),
    name: item.name,
    poster: item.poster || undefined,
    background: item.backdrop || undefined,
    description: item.overview || undefined,
    releaseInfo: item.year
      ? String(item.year)
      : undefined,
  };
}

function metadata(item) {
  const meta = {
    id: item.id,
    type: stremioType(item.kind),
    name: item.name,
    poster: item.poster || undefined,
    background: item.backdrop || undefined,
    description: item.overview || undefined,
    releaseInfo: item.year
      ? String(item.year)
      : undefined,
    imdbRating: item.rating
      ? String(item.rating)
      : undefined,
    genres: Array.isArray(item.genres)
      ? item.genres
      : [],
    runtime: item.runtime
      ? `${item.runtime} min`
      : undefined,
  };

  if (item.trailer) {
    meta.trailers = [{
      source: item.trailer,
      type: "Trailer",
    }];
  }

  if (item.kind !== "movies") {
    meta.videos = (item.episodes || []).map((ep) => ({
      id: `${item.id}:${ep.s}:${ep.e}`,
      title: ep.name || `Episode ${ep.e}`,
      season: Number(ep.s || 1),
      episode: Number(ep.e || 1),
      overview: ep.overview || undefined,
      thumbnail: ep.still || undefined,
      released: ep.air
        ? safeDate(ep.air)
        : undefined,
    }));
  }

  return meta;
}

function safeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toISOString();
}

function parseExtras(parts) {
  const result = {};

  for (const part of parts) {
    const index = part.indexOf("=");

    if (index < 0) continue;

    const key = part.slice(0, index);
    const value = part.slice(index + 1);

    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }

  return result;
}

async function catalog(id, extras) {
  const kind = KIND[id];

  if (!kind) return { metas: [] };

  const skip = Math.max(
    0,
    Number.parseInt(extras.skip || "0", 10) || 0
  );

  const search = String(extras.search || "")
    .trim()
    .toLowerCase();

  const matches = [];
  const batchSize = 6;
  let page = 1;
  let exhausted = false;

  // Read pages in small batches instead of launching
  // 127 simultaneous requests.
  while (
    page <= MAX_WORKER_PAGES &&
    !exhausted &&
    matches.length < skip + PAGE_SIZE
  ) {
    const pages = [];

    for (
      let i = 0;
      i < batchSize && page <= MAX_WORKER_PAGES;
      i++, page++
    ) {
      pages.push(page);
    }

    const results = await Promise.all(
      pages.map(async (p) => {
        try {
          return await getPage(p);
        } catch {
          return null;
        }
      })
    );

    for (const items of results) {
      if (items === null) continue;
      if (items.length === 0) exhausted = true;

      for (const item of items) {
        if (item.kind !== kind) continue;

        if (
          search &&
          !String(item.name || "")
            .toLowerCase()
            .includes(search)
        ) {
          continue;
        }

        matches.push(item);
      }
    }

    if (results.every((items) =>
      items === null || items.length === 0
    )) {
      break;
    }
  }

  return {
    metas: matches
      .slice(skip, skip + PAGE_SIZE)
      .map(catalogCard),
  };
}

function parseStreamLinks(links) {
  return (Array.isArray(links) ? links : [])
    .filter((link) => link && link.url)
    .map((link) => {
      const stream = {
        name: `CTGMovies ${link.quality || "Direct"}`,
        title: `${link.quality || "Direct"} (${link.source || "Server"})`,
        url: link.url,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              Referer: "https://ctgmovies.com/",
            },
          },
        },
      };

      const subs = Array.isArray(link.subs)
        ? link.subs
        : [];

      if (subs.length) {
        stream.subtitles = subs
          .filter((sub) => sub && sub.url)
          .map((sub, index) => ({
            id: String(index),
            url: sub.url,
            lang: sub.label || sub.language || "English",
          }));
      }

      return stream;
    });
}

async function streamsFor(rawId) {
  const parts = rawId.split(":");

  if (parts[0] !== "ctg" || parts.length < 3) {
    return { streams: [] };
  }

  const itemId = parts.slice(0, 3).join(":");
  const season = Number(parts[3] || 1);
  const episode = Number(parts[4] || 1);

  const data = await workerJSON(
    `/stream?id=${encodeURIComponent(itemId)}`
  );

  if (data.id && data.id !== itemId) {
    return { streams: [] };
  }

  const item = await getItem(itemId);

  if (!item) return { streams: [] };

  let links = data.links;

  if (item.kind !== "movies") {
    const episodes = Array.isArray(data.episodes)
      ? data.episodes
      : item.episodes || [];

    const ep = episodes.find(
      (entry) =>
        Number(entry.s || 1) === season &&
        Number(entry.e || 1) === episode
    );

    links = ep ? ep.links : [];
  }

  return {
    streams: parseStreamLinks(
      parseJSON(links, [])
    ),
  };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  try {
    const pathname = new URL(
      req.url || "/",
      "https://vercel.invalid"
    ).pathname;

    const parts = pathname
      .replace(/\.json$/, "")
      .split("/")
      .filter(Boolean);

    const resource = parts[0];

    if (!resource || resource === "manifest") {
      return send(res, 200, manifest);
    }

    if (resource === "status") {
      const data = await workerJSON("/db");

      return send(res, 200, {
        ok: true,
        database: "Cloudflare D1",
        count: data.count || 0,
        worker: WORKER,
      });
    }

    if (resource === "catalog") {
      const id = parts[2];
      const extras = parseExtras(parts.slice(3));
      const result = await catalog(id, extras);

      return send(res, 200, result);
    }

    if (resource === "meta") {
      const id = parts.slice(2).join(":");

      if (!id) {
        return send(res, 400, { meta: null });
      }

      const itemId = id.split(":").slice(0, 3).join(":");
      const item = await getItem(itemId);

      return send(res, 200, {
        meta: item ? metadata(item) : null,
      });
    }

    if (resource === "stream") {
      const id = parts.slice(2).join(":");

      if (!id) {
        return send(res, 200, { streams: [] });
      }

      return send(res, 200, await streamsFor(id));
    }

    return send(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("CTGMovies API error:", error);

    return send(res, 502, {
      error: "Cloudflare Worker request failed",
      detail: error.message,
    });
  }
};
