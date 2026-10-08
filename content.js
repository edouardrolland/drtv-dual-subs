// Content script: collects Danish subtitle cues, translates them and draws a
// two-language overlay on top of the DR TV video player.
(() => {
  'use strict';
  if (window.__drDualContent) return;
  window.__drDualContent = true;

  const DEFAULTS = {
    enabled: true,
    showDanish: true,
    showEnglish: true,
    englishFirst: false,
    fontSize: 100,     // percent
    bottom: 12,        // percent of video height
    hideNative: true,  // hide DR's own subtitle rendering
    offset: 0,         // seconds; positive = subtitles appear later
    engine: 'google',  // 'google' | 'deepl'
    deeplKey: '',
    target: 'en'
  };

  let settings = { ...DEFAULTS };

  // ---------------------------------------------------------------- sources
  // A source is one subtitle track (e.g. "Danish (all)", "Foreign-language only").
  const sources = new Map();   // id -> { id, name, cues, keys, dirty, updated, urls }
  const loadedUrls = new Set(); // subtitle files/playlists already requested
  const segmentUrls = new Set(); // VTT segments we fetch ourselves from playlists
  const playlistDirs = new Set(); // folders of subtitle playlists we download in full
  let sourceChoice = 'auto';
  let lastVideoSrc = null;

  function getSource(id, name) {
    let src = sources.get(id);
    if (!src) {
      src = { id, name, cues: [], keys: new Set(), dirty: false, updated: Date.now(), urls: new Set() };
      sources.set(id, src);
    }
    return src;
  }

  function addCues(src, cues) {
    for (const c of cues) {
      const key = c.start.toFixed(2) + '|' + c.text;
      if (src.keys.has(key)) continue;
      src.keys.add(key);
      src.cues.push(c);
      src.dirty = true;
    }
    src.updated = Date.now();
  }

  function sortedCues(src) {
    if (src.dirty) {
      src.cues.sort((a, b) => a.start - b.start || a.end - b.end);
      src.dirty = false;
    }
    return src.cues;
  }

  function currentSource() {
    if (sourceChoice !== 'auto' && sources.has(sourceChoice)) return sources.get(sourceChoice);
    // The most complete track wins: the "all subtitles" track is a superset of the
    // foreign-language-only one, and fully downloaded files beat partial ones.
    let best = null;
    for (const s of sources.values()) {
      if (!best || s.cues.length > best.cues.length) best = s;
    }
    return best && best.cues.length ? best : null;
  }

  function resetSources(olderThan) {
    for (const [id, s] of sources) {
      if (s.updated < olderThan) {
        for (const u of s.urls) loadedUrls.delete(u);
        sources.delete(id);
      }
    }
    if (!sources.has(sourceChoice)) sourceChoice = 'auto';
  }

  // ---------------------------------------------------------------- parsing
  function parseTimestamp(s) {
    const parts = s.replace(',', '.').split(':').map(Number);
    let secs = 0;
    for (const p of parts) secs = secs * 60 + p;
    return secs;
  }

  function decodeEntities(s) {
    return s
      .replace(/&nbsp;/g, ' ')
      .replace(/&lrm;|&rlm;/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function cleanCueText(s) {
    return decodeEntities(s.replace(/<[^>]*>/g, ''))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
  }

  function parseVtt(text) {
    const cues = [];
    const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
    const re = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
    for (const block of blocks) {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const m = lines[i].match(re);
      if (!m) continue;
      const body = cleanCueText(lines.slice(i + 1).join('\n'));
      if (!body) continue;
      cues.push({ start: parseTimestamp(m[1]), end: parseTimestamp(m[2]), text: body });
    }
    return cues;
  }

  function parseAttributes(line) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(line))) attrs[m[1]] = m[2].replace(/^"|"$/g, '');
    return attrs;
  }

  function stripQuery(url) {
    return String(url).split(/[?#]/)[0];
  }

  function dirOf(url) {
    return stripQuery(url).replace(/[^/]*$/, '');
  }

  function nameFromUrl(url) {
    const u = decodeURIComponent(stripQuery(url));
    if (/Combined/i.test(u)) return 'Danish (all subtitles)';
    if (/HardOfHearing|HoH/i.test(u)) return 'Danish (hard of hearing)';
    if (/Foreign/i.test(u)) return 'Foreign-language parts only';
    const parts = u.split('/').filter(Boolean);
    return parts.slice(-2).join('/') || 'Subtitles';
  }

  function nameFromLanguage(lang, fallbackUrl) {
    const l = String(lang || '');
    if (/Combined/i.test(l)) return 'Danish (all subtitles)';
    if (/HardOfHearing/i.test(l)) return 'Danish (hard of hearing)';
    if (/Foreign/i.test(l)) return 'Foreign-language parts only';
    if (/Danish|^da/i.test(l)) return 'Danish';
    return l || nameFromUrl(fallbackUrl);
  }

  // ------------------------------------------------------- background calls
  function bg(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          if (!res || !res.ok) return reject(new Error((res && res.error) || 'No response'));
          resolve(res);
        });
      } catch (e) {
        reject(e); // extension was reloaded; the page needs a refresh
      }
    });
  }

  const fetchText = (url) => bg({ type: 'fetchText', url }).then((r) => r.text);

  // --------------------------------------------------------- network input
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__drDual !== 1 || typeof d.text !== 'string') return;
    try {
      if (d.kind === 'vtt') onVtt(d.url, d.text);
      else if (d.kind === 'm3u8') onPlaylist(d.url, d.text);
      else if (d.kind === 'json') onJson(d.text);
    } catch (err) {
      console.debug('[DR Dual Subs]', err);
    }
  });

  function onVtt(url, text) {
    if (segmentUrls.has(stripQuery(url)) || playlistDirs.has(dirOf(url))) return; // we already have it
    const cues = parseVtt(text);
    if (!cues.length) return;
    const src = getSource('vtt:' + dirOf(url), nameFromUrl(url));
    src.urls.add(url);
    addCues(src, cues);
  }

  function onPlaylist(url, text) {
    if (/#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES/.test(text)) {
      // Master playlist: lists every subtitle track, even ones not enabled in the player.
      for (const line of text.split('\n')) {
        if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=SUBTITLES/.test(line)) continue;
        const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
        if (!a.URI) continue;
        const trackUrl = new URL(a.URI, url).href;
        const label = a.NAME || a.LANGUAGE || nameFromUrl(trackUrl);
        loadRemote('hls:' + label, label, trackUrl);
      }
    } else if (!loadedUrls.has(url) && /\.(web)?vtt(\?|$)/im.test(text)) {
      loadedUrls.add(url);
      playlistDirs.add(dirOf(url));
      const src = getSource('hls:' + dirOf(url), nameFromUrl(url));
      src.urls.add(url);
      loadMediaPlaylist(src, url, text);
    }
  }

  function onJson(text) {
    let data;
    try { data = JSON.parse(text); } catch { return; }
    for (const { link, language } of findSubtitleLinks(data)) {
      loadRemote('api:' + (language || dirOf(link)), nameFromLanguage(language, link), link);
    }
  }

  // DR's API returns e.g. { subtitles: [{ language: 'CombinedLanguageSubtitles', link: 'https://…vtt' }] }
  function findSubtitleLinks(obj, depth = 0, out = []) {
    if (!obj || typeof obj !== 'object' || depth > 14) return out;
    for (const [key, value] of Object.entries(obj)) {
      if (/subtitle/i.test(key) && Array.isArray(value)) {
        for (const item of value) {
          const link = item && (item.link || item.url || item.uri || item.href);
          if (typeof link === 'string' && /^https:/.test(link)) {
            out.push({ link, language: item.language || item.languageCode || item.label || item.name });
          }
        }
      }
      if (value && typeof value === 'object') findSubtitleLinks(value, depth + 1, out);
    }
    return out;
  }

  async function loadRemote(id, name, url) {
    if (loadedUrls.has(url)) return;
    loadedUrls.add(url);
    if (/\.m3u8(\?|$)/i.test(url)) playlistDirs.add(dirOf(url));
    const src = getSource(id, name);
    src.urls.add(url);
    try {
      const text = await fetchText(url);
      if (text.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U')) {
        await loadMediaPlaylist(src, url, text);
      } else {
        addCues(src, parseVtt(text));
      }
    } catch (err) {
      loadedUrls.delete(url);
      console.debug('[DR Dual Subs] could not load', url, err);
    }
  }

  // Downloads every VTT segment of an HLS subtitle playlist, nearest-to-playhead first.
  async function loadMediaPlaylist(src, url, text) {
    const segments = [];
    let t = 0;
    let duration = 0;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8)) || 0;
      if (!line || line.startsWith('#')) continue;
      const segUrl = new URL(line, url).href;
      if (/\.(ts|m4s|mp4|aac|m4a)(\?|$)/i.test(segUrl)) return; // not a subtitle playlist
      segments.push({ url: segUrl, start: t });
      segmentUrls.add(stripQuery(segUrl));
      t += duration;
    }
    const now = (findVideo() && findVideo().currentTime) || 0;
    const ahead = segments.filter((s) => s.start >= now - 30);
    const behind = segments.filter((s) => s.start < now - 30).reverse();
    const queue = [...ahead, ...behind];

    const worker = async () => {
      while (queue.length) {
        const seg = queue.shift();
        try {
          addCues(src, parseVtt(await fetchText(seg.url)));
        } catch (err) {
          console.debug('[DR Dual Subs] segment failed', seg.url, err);
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  // Native text tracks (if the player uses them) already have correct timing.
  function readNativeTracks(video) {
    const tracks = video.textTracks;
    if (!tracks) return;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
      if (settings.enabled && settings.hideNative && track.mode === 'showing') track.mode = 'hidden';
      const list = track.cues;
      if (!list || !list.length) continue;
      const src = getSource('track:' + i + ':' + (track.label || track.language),
        track.label || track.language || 'Player track ' + (i + 1));
      if (src.nativeCount === list.length) continue;
      src.nativeCount = list.length;
      const cues = [];
      for (let j = 0; j < list.length; j++) {
        const c = list[j];
        const body = cleanCueText(String(c.text || ''));
        if (body) cues.push({ start: c.startTime, end: c.endTime, text: body });
      }
      addCues(src, cues);
    }
  }

  // ------------------------------------------------------------ translation
  const translations = new Map(); // Danish cue text -> English text
  const pending = new Set();
  let inFlight = 0;
  let backoffUntil = 0;
  let lastError = '';

  // Dialogue cues ("- Hej.\n- Hej med dig.") keep their line breaks; otherwise
  // lines are one sentence that was wrapped, so join them for a better translation.
  function prepareForTranslation(text) {
    const lines = text.split('\n');
    return lines.some((l) => /^[-–]/.test(l)) ? text : lines.join(' ');
  }

  // Translations are also saved in chrome.storage.local, so a programme that was
  // watched (or pre-translated) before shows English instantly.
  const cacheKey = (text) => `t|${settings.engine}|${settings.target}|${text}`;

  function cacheGet(texts) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(texts.map(cacheKey), (items) => resolve(items || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  function cacheSet(pairs) {
    const items = {};
    for (const [da, en] of pairs) items[cacheKey(da)] = en;
    try { chrome.storage.local.set(items); } catch (e) { /* ignore */ }
  }

  // Order of work: current track from the playhead onwards, then the start of the
  // current track (for seeking back), then other tracks (in case the user switches).
  function translationOrder() {
    const cur = currentSource();
    if (!cur) return [];
    const cues = sortedCues(cur);
    const startIdx = Math.max(0, lowerBound(cues, playheadTime() - 2));
    const order = cues.slice(startIdx).concat(cues.slice(0, startIdx));
    for (const s of sources.values()) if (s !== cur) order.push(...s.cues);
    return order;
  }

  async function translationScheduler() {
    if (!settings.enabled || !settings.showEnglish) return;
    if (inFlight >= 3 || Date.now() < backoffUntil) return;

    const batch = [];
    const seen = new Set();
    let chars = 0;
    for (const c of translationOrder()) {
      if (translations.has(c.text) || pending.has(c.text) || seen.has(c.text)) continue;
      if (batch.length >= 60 || chars + c.text.length > 4000) break;
      seen.add(c.text);
      batch.push(c.text);
      chars += c.text.length;
    }
    if (!batch.length) return;

    batch.forEach((b) => pending.add(b));
    inFlight++;
    const engineAtRequest = settings.engine + '|' + settings.target;
    try {
      const cached = await cacheGet(batch);
      const missing = [];
      for (const b of batch) {
        const hit = cached[cacheKey(b)];
        if (typeof hit === 'string') translations.set(b, hit); else missing.push(b);
      }
      if (missing.length) {
        const res = await bg({
          type: 'translate',
          texts: missing.map(prepareForTranslation),
          opts: { engine: settings.engine, target: settings.target, deeplKey: settings.deeplKey }
        });
        if (engineAtRequest === settings.engine + '|' + settings.target) {
          const pairs = missing.map((b, i) => [b, res.translations[i] || '']);
          pairs.forEach(([da, en]) => translations.set(da, en));
          cacheSet(pairs);
        }
      }
      lastError = '';
    } catch (err) {
      lastError = err.message;
      backoffUntil = Date.now() + 5000;
      console.debug('[DR Dual Subs] translation failed:', err.message);
    } finally {
      batch.forEach((b) => pending.delete(b));
      inFlight--;
    }
    translationScheduler(); // keep going straight away while there is work left
  }

  // First index whose cue starts at/after t, moved back over cues still running at t.
  function lowerBound(cues, t) {
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start < t) lo = mid + 1; else hi = mid;
    }
    while (lo > 0 && cues[lo - 1].end > t) lo--;
    return lo;
  }

  // ---------------------------------------------------------------- overlay
  let host = null;
  let elDa = null;
  let elEn = null;
  let elBox = null;
  let elToast = null;
  let shownDa = null;
  let shownEn = null;
  let toastTimer = 0;

  function buildOverlay() {
    host = document.createElement('div');
    host.id = 'drdual-subs-host';
    host.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;left:0;top:0;width:0;height:0;display:none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box {
          position: absolute; left: 50%; transform: translateX(-50%);
          width: max-content; max-width: 88%;
          display: flex; flex-direction: column; align-items: center; gap: .25em;
          text-align: center; font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        }
        .line {
          white-space: pre-line; line-height: 1.3; padding: .12em .5em; border-radius: .25em;
          background: rgba(0, 0, 0, .72); text-shadow: 0 1px 2px #000;
        }
        .line:empty { display: none; }
        .da { color: #fff; font-weight: 600; }
        .en { color: #ffe066; font-weight: 500; font-style: italic; }
        .toast {
          position: absolute; top: 4%; right: 3%; padding: .4em .8em; border-radius: .4em;
          background: rgba(0, 0, 0, .8); color: #fff; font: 600 15px system-ui, sans-serif;
          opacity: 0; transition: opacity .2s;
        }
        .toast.show { opacity: 1; }
      </style>
      <div class="box"><div class="line da"></div><div class="line en"></div></div>
      <div class="toast"></div>`;
    elBox = root.querySelector('.box');
    elDa = root.querySelector('.da');
    elEn = root.querySelector('.en');
    elToast = root.querySelector('.toast');
  }

  function toast(text) {
    if (!host) return;
    elToast.textContent = text;
    elToast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elToast.classList.remove('show'), 1500);
  }

  function findVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  function playheadTime() {
    const v = findVideo();
    return v ? v.currentTime - (Number(settings.offset) || 0) : 0;
  }

  function activeCues(cues, t) {
    const out = [];
    let i = lowerBound(cues, t);
    // lowerBound stops at the first cue starting >= t (or one still running);
    // look a few cues back for overlapping ones.
    for (let j = Math.max(0, i - 8); j < cues.length && cues[j].start <= t; j++) {
      if (cues[j].end > t) out.push(cues[j]);
    }
    return out;
  }

  function render() {
    requestAnimationFrame(render);
    const video = settings.enabled ? findVideo() : null;
    if (video) {
      const vsrc = video.currentSrc || video.src;
      if (vsrc && vsrc !== lastVideoSrc) {
        // New programme: drop tracks that belong to the previous one.
        if (lastVideoSrc) resetSources(Date.now() - 15000);
        lastVideoSrc = vsrc;
      }
    }
    const src = video && currentSource();
    const rect = video && video.getBoundingClientRect();
    if (!src || !rect || rect.width < 50) {
      if (host) host.style.display = 'none';
      return;
    }
    if (!host) buildOverlay();

    // Must live inside the fullscreen element to stay visible in fullscreen.
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.body || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);

    Object.assign(host.style, {
      display: 'block',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px'
    });
    const base = Math.max(12, rect.height * 0.042) * (Number(settings.fontSize) || 100) / 100;
    elBox.style.fontSize = base + 'px';
    elBox.style.bottom = (Number(settings.bottom) || 0) + '%';
    elBox.style.flexDirection = settings.englishFirst ? 'column-reverse' : 'column';
    elEn.style.fontSize = '0.88em';

    const cues = activeCues(sortedCues(src), video.currentTime - (Number(settings.offset) || 0));
    const da = settings.showDanish ? cues.map((c) => c.text).join('\n') : '';
    const en = settings.showEnglish
      ? cues.map((c) => translations.get(c.text) ?? '…').join('\n')
      : '';
    if (da !== shownDa) { elDa.textContent = da; shownDa = da; }
    if (en !== shownEn) { elEn.textContent = en; shownEn = en; }
  }

  // ---------------------------------------------------- hide DR's subtitles
  let hideStyle = null;
  function applyHideNative() {
    const want = settings.enabled && settings.hideNative;
    if (want && !hideStyle) {
      hideStyle = document.createElement('style');
      hideStyle.textContent = `
        video::cue { color: transparent !important; background: transparent !important; text-shadow: none !important; }
        .shaka-text-container, .vjs-text-track-display { visibility: hidden !important; }`;
      (document.head || document.documentElement).appendChild(hideStyle);
    } else if (!want && hideStyle) {
      hideStyle.remove();
      hideStyle = null;
    }
  }

  // --------------------------------------------------------------- settings
  function saveSetting(key, value) {
    settings[key] = value;
    chrome.storage.sync.set({ [key]: value });
  }

  chrome.storage.sync.get(DEFAULTS, (s) => {
    settings = { ...DEFAULTS, ...s };
    applyHideNative();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    if (changes.engine || changes.target) translations.clear();
    applyHideNative();
  });

  // Alt+D / Alt+E toggle Danish / English, Alt+, and Alt+. shift timing.
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
    let handled = true;
    if (e.code === 'KeyD') {
      saveSetting('showDanish', !settings.showDanish);
      toast('Danish ' + (settings.showDanish ? 'on' : 'off'));
    } else if (e.code === 'KeyE') {
      saveSetting('showEnglish', !settings.showEnglish);
      toast('English ' + (settings.showEnglish ? 'on' : 'off'));
    } else if (e.code === 'Comma' || e.code === 'Period') {
      const delta = e.code === 'Comma' ? -0.25 : 0.25;
      saveSetting('offset', Math.round(((Number(settings.offset) || 0) + delta) * 100) / 100);
      toast(`Subtitle delay ${settings.offset > 0 ? '+' : ''}${settings.offset.toFixed(2)} s`);
    } else {
      handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ------------------------------------------------------------ popup API
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'status') {
      const cur = currentSource();
      if (!findVideo() && !sources.size) return; // let a frame with the video answer
      const cues = cur ? cur.cues : [];
      sendResponse({
        hasVideo: !!findVideo(),
        sources: [...sources.values()].map((s) => ({ id: s.id, name: s.name, count: s.cues.length })),
        current: cur ? cur.id : null,
        choice: sourceChoice,
        translated: cues.filter((c) => translations.has(c.text)).length,
        total: cues.length,
        error: lastError
      });
    } else if (msg.type === 'setSource') {
      sourceChoice = msg.id;
      sendResponse({ ok: true });
    }
  });

  // ------------------------------------------------------------------ loop
  setInterval(() => {
    const v = findVideo();
    if (v) readNativeTracks(v);
    translationScheduler();
  }, 400);

  requestAnimationFrame(render);
})();
