// Service worker: performs cross-origin requests on behalf of the content script
// (subtitle downloads and translation calls).

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // async response
});

async function handle(msg) {
  switch (msg && msg.type) {
    case 'fetchText':
      return { text: await fetchText(msg.url) };
    case 'translate':
      return { translations: await translate(msg.texts, msg.opts || {}) };
    default:
      throw new Error('Unknown message type');
  }
}

async function fetchText(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('Only https URLs are allowed');
  const res = await fetch(u.href, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${u.href}`);
  return res.text();
}

async function translate(texts, { engine = 'google', target = 'en', deeplKey = '' }) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (engine === 'deepl') {
    if (!deeplKey) throw new Error('DeepL selected but no API key set');
    return translateDeepL(texts, target, deeplKey);
  }
  return translateGoogle(texts, target);
}

// Free Google Translate web endpoint. Each `q` is translated separately and the
// response is an array aligned with the inputs.
async function translateGoogle(texts, target) {
  const body = new URLSearchParams();
  for (const t of texts) body.append('q', t);
  const url = `https://translate.googleapis.com/translate_a/t?client=gtx&sl=da&tl=${encodeURIComponent(target)}&dt=t`;
  const res = await fetch(url, { method: 'POST', body });
  if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
  let data = await res.json();
  if (!Array.isArray(data)) data = [data];
  const out = data.map((item) => (Array.isArray(item) ? item[0] : item));
  if (out.length !== texts.length) throw new Error('Google Translate returned a mismatched batch');
  return out.map((s) => String(s ?? ''));
}

async function translateDeepL(texts, target, key) {
  const host = key.trim().endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const t = target.toLowerCase();
  const targetLang = t === 'en' ? 'EN-GB' : t === 'pt' ? 'PT-PT' : t.toUpperCase();
  const res = await fetch(`https://${host}/v2/translate`, {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${key.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text: texts, source_lang: 'DA', target_lang: targetLang })
  });
  if (!res.ok) throw new Error(`DeepL HTTP ${res.status}`);
  const data = await res.json();
  return data.translations.map((x) => x.text);
}
