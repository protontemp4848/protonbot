const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Crude but dependency-free HTML -> readable text. Keeps table cells and list items on their own lines. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table|\/ul|\/ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/( *\| *)+(\n|$)/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Looks things up on a MediaWiki site (e.g. a Fextralife game wiki) via its API at <baseUrl>/api.php.
 * Results are cached in memory so repeated questions don't hit the wiki.
 */
export class MediaWiki {
  constructor({
    baseUrl,
    label = 'wiki', // log prefix, so lookups on different wikis can be told apart
    maxChars = 6_000,
    ttlMs = 60 * 60_000,
    maxEntries = 100,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    log = console,
  } = {}) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), label, maxChars, ttlMs, maxEntries, fetchImpl, now, log });
    this.cache = new Map();
  }

  pageUrl(title) {
    return `${this.baseUrl}/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/')}`;
  }

  /** Search the wiki and return the best page as text, or null if nothing matches. */
  async lookup(query) {
    query = String(query ?? '').trim().slice(0, 200);
    if (!query) return null;
    const key = query.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) {
      this.log.debug?.(`[${this.label}] cache hit "${query}" -> ${hit.value?.title ?? 'no results'}`);
      return hit.value;
    }
    const started = this.now();

    const titles = await this.#findTitles(query);
    let value = null;
    if (titles.length) {
      const page = await this.#api({ action: 'parse', page: titles[0], prop: 'text', redirects: '1', disableeditsection: '1' });
      const title = page.parse?.title ?? titles[0];
      let text = htmlToText(page.parse?.text);
      if (text.length > this.maxChars) text = text.slice(0, this.maxChars) + '\n[truncated]';
      value = { title, url: this.pageUrl(title), text, otherResults: titles.slice(1).filter((t) => t.toLowerCase() !== title.toLowerCase()).slice(0, 4) };
    }
    this.log.debug?.(`[${this.label}] fetched "${query}" -> ${value ? value.title : 'no results'} in ${this.now() - started}ms (candidates: ${titles.join(' | ') || 'none'})`);

    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), value });
    if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  /**
   * The wiki's built-in search is weak (no relevance ranking, every word must match), so combine
   * title prefix search and title search, prefer an exact title match, and only fall back to full text.
   */
  async #findTitles(query) {
    const [prefix, byTitle] = await Promise.all([
      this.#api({ action: 'opensearch', search: query, limit: '5', namespace: '0', redirects: 'resolve' }),
      this.#api({ action: 'query', list: 'search', srsearch: query, srwhat: 'title', srlimit: '5', srnamespace: '0' }),
    ]);
    let titles = [...(prefix[1] ?? []), ...(byTitle.query?.search ?? []).map((r) => r.title)];
    if (!titles.length) {
      const text = await this.#api({ action: 'query', list: 'search', srsearch: query, srwhat: 'text', srlimit: '5', srnamespace: '0' });
      titles = (text.query?.search ?? []).map((r) => r.title);
    }
    // The wiki has many near-duplicate pages differing only in case, e.g. "Gladius (Enemy)" / "Gladius (enemy)".
    const seen = new Set();
    titles = titles.filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
    const exact = titles.findIndex((t) => t.toLowerCase() === query.toLowerCase());
    if (exact > 0) titles.unshift(...titles.splice(exact, 1));
    return titles;
  }

  async #api(params) {
    const qs = new URLSearchParams({ ...params, format: 'json', formatversion: '2' });
    const res = await this.fetchImpl(`${this.baseUrl}/api.php?${qs}`, {
      headers: { 'User-Agent': 'protonbot/0.1 (Twitch chat bot)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`wiki HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`wiki API: ${data.error.info ?? data.error.code}`);
    return data;
  }
}
