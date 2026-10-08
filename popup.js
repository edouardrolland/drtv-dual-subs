const DEFAULTS = {
  enabled: true,
  showDanish: true,
  showEnglish: true,
  englishFirst: false,
  fontSize: 100,
  bottom: 12,
  hideNative: true,
  offset: 0,
  engine: 'google',
  deeplKey: '',
  target: 'en'
};

const $ = (id) => document.getElementById(id);

function showValues(s) {
  $('fontSizeVal').textContent = s.fontSize + '%';
  $('bottomVal').textContent = s.bottom + '%';
  $('offsetVal').textContent = (s.offset > 0 ? '+' : '') + Number(s.offset).toFixed(2);
  $('deeplRow').hidden = s.engine !== 'deepl';
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  for (const key of Object.keys(DEFAULTS)) {
    const el = $(key);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!s[key];
    else el.value = s[key];

    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      let value = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'range') value = Number(value);
      s[key] = value;
      chrome.storage.sync.set({ [key]: value });
      showValues(s);
    });
  }
  showValues(s);
});

let activeTabId = null;

function refreshStatus() {
  if (activeTabId == null) return;
  chrome.tabs.sendMessage(activeTabId, { type: 'status' }, (res) => {
    const status = $('status');
    if (chrome.runtime.lastError || !res) {
      status.textContent = 'Open a programme on dr.dk/drtv and start playback. (If you just installed the extension, reload the page.)';
      return;
    }
    if (!res.total) {
      status.textContent = res.hasVideo
        ? 'Video found, waiting for subtitles… (try turning on subtitles in the DR player)'
        : 'Waiting for a video…';
    } else {
      status.textContent = `${res.total} subtitle lines · ${res.translated} translated`;
    }
    if (res.error) {
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = 'Translation error: ' + res.error;
      status.appendChild(err);
    }

    const select = $('source');
    const wanted = ['auto', ...res.sources.map((x) => x.id)].join('\n');
    if (select.dataset.ids !== wanted) {
      select.dataset.ids = wanted;
      select.length = 1;
      for (const src of res.sources) select.add(new Option(src.name, src.id));
    }
    for (let i = 1; i < select.options.length; i++) {
      const src = res.sources[i - 1];
      select.options[i].text = `${src.name} (${src.count})${src.id === res.current ? ' ✓' : ''}`;
    }
    if (document.activeElement !== select) select.value = res.choice;
  });
}

$('source').addEventListener('change', (e) => {
  chrome.tabs.sendMessage(activeTabId, { type: 'setSource', id: e.target.value });
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  activeTabId = tabs[0] && tabs[0].id;
  refreshStatus();
  setInterval(refreshStatus, 1000);
});
