# DR TV Dual Subtitles

A Chrome extension that shows Danish subtitles **together with** an English translation on DR TV (dr.dk/drtv). It's meant for people learning Danish.

## Install (developer mode)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this folder.
3. Open a programme on https://www.dr.dk/drtv and press play. Reload the tab if it was already open.

## How it works

- `inject.js` runs in the page and watches the player's network traffic, without changing it. It copies three kinds of responses to the extension: WebVTT subtitle files, HLS playlists, and DR API JSON that contains `subtitles` links.
- `content.js` builds subtitle tracks from that traffic:
  - every `TYPE=SUBTITLES` track listed in the HLS master playlist,
  - the subtitle links in DR's API responses,
  - the player's native text tracks, if any.

  For tracks it finds through playlists or API links, it downloads the whole file, so translation can run ahead of playback. By default it picks the most complete track (all Danish speech, not only the foreign-language parts).
- The whole programme is translated in advance in batches of up to 60 lines (3 requests at a time), starting from the playhead. Translations are cached in `chrome.storage.local`, so a programme you have already watched shows the translation instantly. The extension then draws both languages over the video, including in fullscreen.
- `background.js` handles the downloads and translation calls. It uses the free Google Translate endpoint by default, or DeepL if you add your own API key in the popup (a free DeepL key ends in `:fx`).

## Controls

| Key | Action |
|---|---|
| Alt+D | Show/hide Danish |
| Alt+E | Show/hide translation |
| Alt+, / Alt+. | Move subtitles 0.25 s earlier / later |

The toolbar popup has the remaining settings: text size, position, order, which subtitle track to use, translation engine and target language.

## Troubleshooting

- **Nothing appears:** turn on subtitles once in the DR player, so it loads the subtitle playlist.
- **Subtitles appear twice:** keep "Hide DR's own subtitles" on, or turn subtitles off in the DR player after they have loaded.
- **Out of sync:** use Alt+, / Alt+. to adjust the timing.
- **"Translation error":** Google's free endpoint sometimes rate-limits; the extension retries after 5 s. Switch to DeepL if it keeps happening.
- Debug logs are printed with `console.debug` and the prefix `[DR Dual Subs]`. To see them, enable "Verbose" in DevTools.
