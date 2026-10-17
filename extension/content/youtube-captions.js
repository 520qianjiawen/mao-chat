/* global chrome */
/*
 * YouTube caption reader for MAO Chat.
 * Prefers the player's own timedtext response (includes the pot token).
 * Falls back to on-screen .ytp-caption-segment lines — the same wrap points
 * kiss-translator uses — when a bare timedtext fetch comes back empty.
 */
(function () {
  if (window.__maoYoutubeCaptionsLoaded__) return;
  window.__maoYoutubeCaptionsLoaded__ = true;

  var intercepted = { potUrl: '', eventsByLang: {}, lastEvents: [] };

  function extractJsonAssignment(source, name) {
    const key = name + ' = ';
    const idx = source.indexOf(key);
    if (idx < 0) return null;
    const start = source.indexOf('{', idx);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }

  function videoIdFromLocation() {
    try {
      const url = new URL(location.href);
      const v = url.searchParams.get('v');
      if (v) return v;
      const shorts = url.pathname.match(/^\/shorts\/([^/?#]+)/);
      if (shorts) return shorts[1];
      const live = url.pathname.match(/^\/live\/([^/?#]+)/);
      if (live) return live[1];
      const embed = url.pathname.match(/^\/embed\/([^/?#]+)/);
      if (embed) return embed[1];
    } catch { /* ignore */ }
    return null;
  }

  function readPlayerResponse() {
    try {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const live = player.getPlayerResponse();
        if (live) return live;
      }
    } catch { /* ignore */ }
    const scripts = document.getElementsByTagName('script');
    for (let i = 0; i < scripts.length; i++) {
      const text = scripts[i].textContent || '';
      if (!text.includes('ytInitialPlayerResponse')) continue;
      const parsed = extractJsonAssignment(text, 'ytInitialPlayerResponse');
      if (parsed) return parsed;
    }
    return null;
  }

  function tracksFromPlayer(player) {
    const raw = player && player.captions
      && player.captions.playerCaptionsTracklistRenderer
      && player.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!Array.isArray(raw)) return [];
    return raw.map((track) => ({
      languageCode: String(track.languageCode || ''),
      baseUrl: String(track.baseUrl || ''),
      kind: track.kind ? String(track.kind) : undefined,
      name: (track.name && (track.name.simpleText || (track.name.runs && track.name.runs[0] && track.name.runs[0].text))) || undefined,
    })).filter((track) => track.baseUrl && track.languageCode);
  }

  function timedTextUrl(baseUrl) {
    const url = new URL(baseUrl, location.origin);
    url.searchParams.delete('tlang');
    url.searchParams.set('fmt', 'json3');
    return url.toString();
  }

  function timedTextUrlWithPot(baseUrl, potHref) {
    const json3 = timedTextUrl(baseUrl);
    if (!potHref) return json3;
    try {
      const cap = new URL(json3);
      const pot = new URL(potHref, location.origin);
      pot.searchParams.delete('tlang');
      pot.searchParams.delete('name');
      pot.searchParams.set('fmt', 'json3');
      const lang = cap.searchParams.get('lang');
      const kind = cap.searchParams.get('kind');
      if (lang) pot.searchParams.set('lang', lang);
      if (kind) pot.searchParams.set('kind', kind);
      else pot.searchParams.delete('kind');
      return pot.toString();
    } catch {
      return json3;
    }
  }

  function videoEl() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  function rememberIntercepted(url, responseText) {
    if (!url || !responseText) return;
    let json;
    try { json = JSON.parse(responseText); } catch { return; }
    const events = json && Array.isArray(json.events) ? json.events : [];
    if (events.length === 0) return;
    intercepted.potUrl = url;
    intercepted.lastEvents = events;
    try {
      const parsed = new URL(url, location.origin);
      const lang = parsed.searchParams.get('lang') || '';
      const kind = parsed.searchParams.get('kind') || '';
      intercepted.eventsByLang[lang + '|' + kind] = events;
    } catch { /* keep lastEvents */ }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== 'mao-youtube-timedtext') return;
    rememberIntercepted(data.url, data.response);
  });

  function enableNativeCaptions() {
    const btn = document.querySelector('.ytp-subtitles-button');
    if (btn && btn.getAttribute('aria-pressed') !== 'true') {
      try { btn.click(); } catch { /* ignore */ }
      return true;
    }
    return btn ? btn.getAttribute('aria-pressed') === 'true' : false;
  }

  function readOnscreenLines() {
    const nodes = document.querySelectorAll('.ytp-caption-segment');
    const lines = [];
    for (let i = 0; i < nodes.length; i++) {
      const text = String(nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
    }
    return lines;
  }

  function interceptedEventsFor(track) {
    const lang = track && track.languageCode || '';
    const kind = track && track.kind || '';
    return intercepted.eventsByLang[lang + '|' + kind]
      || intercepted.eventsByLang[lang + '|']
      || intercepted.lastEvents
      || [];
  }

  async function loadCaptions() {
    const videoId = videoIdFromLocation();
    if (!videoId) return { ok: false, reason: 'not-watch' };

    enableNativeCaptions();

    let player = readPlayerResponse();
    let tracks = tracksFromPlayer(player);
    if (tracks.length === 0) {
      try {
        const html = await fetch(location.href, { credentials: 'same-origin' }).then((r) => r.text());
        player = extractJsonAssignment(html, 'ytInitialPlayerResponse');
        tracks = tracksFromPlayer(player);
      } catch {
        tracks = [];
      }
    }

    const eventsByUrl = {};
    if (tracks.length > 0) {
      await Promise.all(tracks.map(async (track) => {
        const cached = interceptedEventsFor(track);
        if (cached.length) {
          eventsByUrl[track.baseUrl] = cached;
          return;
        }
        try {
          const res = await fetch(timedTextUrlWithPot(track.baseUrl, intercepted.potUrl), {
            credentials: 'same-origin',
          });
          if (!res.ok) {
            eventsByUrl[track.baseUrl] = [];
            return;
          }
          const json = await res.json();
          eventsByUrl[track.baseUrl] = Array.isArray(json && json.events) ? json.events : [];
        } catch {
          eventsByUrl[track.baseUrl] = [];
        }
      }));
    }

    const onscreen = readOnscreenLines();
    const hasEvents = Object.keys(eventsByUrl).some((url) => (eventsByUrl[url] || []).length > 0);
    if (tracks.length === 0 && !hasEvents && onscreen.length === 0) {
      return { ok: false, reason: 'no-tracks', videoId, onscreen: [] };
    }

    return {
      ok: true,
      videoId,
      tracks,
      eventsByUrl,
      onscreen,
      pot: Boolean(intercepted.potUrl),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return undefined;
    if (msg.type === 'youtube-caption:probe') {
      sendResponse({ ok: true, youtube: true, videoId: videoIdFromLocation() });
      return false;
    }
    if (msg.type === 'youtube-caption:load') {
      loadCaptions().then(sendResponse).catch((error) => {
        sendResponse({ ok: false, reason: String(error && error.message || error) });
      });
      return true;
    }
    if (msg.type === 'youtube-caption:enable') {
      sendResponse({ ok: true, enabled: enableNativeCaptions(), onscreen: readOnscreenLines() });
      return false;
    }
    if (msg.type === 'youtube-caption:onscreen') {
      const video = videoEl();
      sendResponse({
        ok: true,
        videoId: videoIdFromLocation(),
        currentTimeMs: video ? Math.round(video.currentTime * 1000) : 0,
        paused: video ? video.paused : true,
        lines: readOnscreenLines(),
      });
      return false;
    }
    if (msg.type === 'youtube-caption:time') {
      const video = videoEl();
      sendResponse({
        ok: Boolean(video),
        videoId: videoIdFromLocation(),
        currentTimeMs: video ? Math.round(video.currentTime * 1000) : 0,
        paused: video ? video.paused : true,
      });
      return false;
    }
    return undefined;
  });
})();
