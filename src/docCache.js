import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Turn any Google Doc share/edit link into its plain-text export URL. */
export function toExportUrl(url) {
  const m = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{20,})/);
  if (!m) throw new Error(`Not a Google Doc link: ${url} (expected https://docs.google.com/document/d/<id>/...)`);
  return `https://docs.google.com/document/d/${m[1]}/export?format=txt`;
}

/**
 * Fetches a public Google Doc as text, cached in memory for `ttlMs`.
 * Every process start fetches the doc fresh. The copy on disk is only used if Google can't be reached,
 * and if a later refresh fails the stale copy is served too, so the bot keeps working.
 */
export class DocCache {
  constructor({ url, ttlMs, cachePath, maxChars = 40_000, fetchImpl = globalThis.fetch, now = Date.now, log = console }) {
    Object.assign(this, { url, ttlMs, cachePath, maxChars, fetchImpl, now, log });
    this.text = null;
    this.fetchedAt = 0;
    this.inflight = null;
  }

  async get() {
    if (!this.url) return '';
    if (this.text !== null && this.now() - this.fetchedAt < this.ttlMs) return this.text;
    if (this.text === null) await this.#loadDisk();
    if (this.text !== null && this.now() - this.fetchedAt < this.ttlMs) return this.text;
    this.inflight ??= this.#refresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  /**
   * Fetches the doc now, skipping the cache (for !reload). Returns { text, changed }. If Google can't be reached it
   * throws and keeps serving the copy it had.
   */
  async reload() {
    if (!this.url) throw new Error('no GOOGLE_DOC_URL is set');
    const before = this.text;
    const text = await this.#fetch();
    return { text, changed: text !== before };
  }

  async #loadDisk() {
    try {
      const [text, s] = await Promise.all([readFile(this.cachePath, 'utf8'), stat(this.cachePath)]);
      // Kept only as a fallback: always treated as stale, so a restart always pulls the latest doc.
      this.text = text;
      this.fetchedAt = -Infinity;
      this.log.info(`[doc] found ${text.length} chars in ${this.cachePath} (${Math.round((this.now() - s.mtimeMs) / 60_000)} min old), fetching latest from Google`);
    } catch {}
  }

  async #refresh() {
    try {
      return await this.#fetch();
    } catch (err) {
      if (this.text !== null) {
        this.log.warn(`[doc] refresh failed (${err.message}), using stale cache`);
        // Don't hammer Google: wait a full TTL before retrying.
        this.fetchedAt = this.now();
        return this.text;
      }
      throw new Error(`[doc] could not load Google Doc: ${err.message}`);
    }
  }

  async #fetch() {
    const res = await this.fetchImpl(toExportUrl(this.url), { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Private docs redirect to a Google sign-in HTML page instead of returning text.
    if (/text\/html/i.test(res.headers.get('content-type') ?? '')) {
      throw new Error('got an HTML page, the doc is probably not shared as "Anyone with the link can view"');
    }
    const text = (await res.text()).replace(/^﻿/, '').trim().slice(0, this.maxChars);
    this.text = text;
    this.fetchedAt = this.now();
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, text);
    this.log.info(`[doc] refreshed (${text.length} chars)`);
    return text;
  }
}
