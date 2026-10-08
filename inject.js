// Runs in the page's own JS world (MAIN) so it can observe the player's network
// traffic. It never modifies requests or responses: it only copies subtitle
// files (WebVTT), HLS playlists and subtitle-bearing JSON to content.js.
(() => {
  'use strict';
  if (window.__drDualHooked) return;
  window.__drDualHooked = true;

  const MAX_LEN = 8_000_000;

  const post = (kind, url, text) => {
    window.postMessage({ __drDual: 1, kind, url: String(url), text }, '*');
  };

  const interesting = (url, contentType) => {
    url = String(url || '');
    const ct = String(contentType || '').toLowerCase();
    return /\.(m3u8|vtt|webvtt)(\?|#|$)/i.test(url) ||
      /subtitle/i.test(url) ||
      /vtt|mpegurl|json|text\/plain/.test(ct);
  };

  const classify = (text) => {
    if (typeof text !== 'string' || !text || text.length > MAX_LEN) return null;
    const head = text.slice(0, 64).replace(/^﻿/, '').trimStart();
    if (head.startsWith('WEBVTT')) return 'vtt';
    if (head.startsWith('#EXTM3U')) return 'm3u8';
    if ((head[0] === '{' || head[0] === '[') && /subtitle/i.test(text)) return 'json';
    return null;
  };

  const report = (url, text) => {
    const kind = classify(text);
    if (kind) post(kind, url, text);
  };

  // fetch()
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const promise = origFetch.apply(this, arguments);
      promise.then((res) => {
        try {
          const url = res.url || (input && input.url) || String(input);
          if (!interesting(url, res.headers.get('content-type'))) return;
          res.clone().text().then((t) => report(url, t), () => {});
        } catch (e) { /* ignore */ }
      }, () => {});
      return promise;
    };
  }

  // XMLHttpRequest
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (method, url) {
    this.__drDualUrl = url;
    return origOpen.apply(this, arguments);
  };
  XHR.send = function () {
    this.addEventListener('load', () => {
      try {
        const url = this.responseURL || String(this.__drDualUrl || '');
        if (!interesting(url, this.getResponseHeader('content-type'))) return;
        const rt = this.responseType;
        let text = null;
        if (rt === '' || rt === 'text') text = this.responseText;
        else if (rt === 'json') text = JSON.stringify(this.response);
        else if (rt === 'arraybuffer' && this.response && this.response.byteLength < MAX_LEN) {
          text = new TextDecoder().decode(this.response);
        }
        report(url, text);
      } catch (e) { /* ignore */ }
    });
    return origSend.apply(this, arguments);
  };
})();
