// Spawn and parse the per-application capture helper (issue #335).
//
// Platform-neutral: the Windows, macOS and any future helper all honour the same
// command line (--list / --target pid:N, PCM on stdout, JSON lines on stderr),
// so this layer needs no per-platform branching. Locating the binary is the only
// platform-specific part, and that lives in audio-host-path.js.
//
// The helper is a short-lived filter, not a daemon: `--list` runs and exits,
// `--target` streams PCM on stdout until killed. Nothing here keeps a socket or
// a handshake, so there is no surface for other local processes to attach to.
const { spawn: nodeSpawn } = require('child_process');
const { resolveAudioHostPath } = require('./audio-host-path.js');

// At most one capture runs at a time; switching sources kills the previous one.
let current = null;

/**
 * Turn a stream of stderr chunks into whole JSON lines.
 * Chunk boundaries fall mid-line often enough that naive per-chunk parsing
 * drops events.
 */
function makeLineParser(onLine) {
  let buffered = '';
  return (chunk) => {
    buffered += chunk.toString('utf8');
    let idx;
    while ((idx = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, idx).trim();
      buffered = buffered.slice(idx + 1);
      if (!line) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        // The helper only writes JSON, but never let a stray line kill capture.
      }
    }
  };
}

/**
 * `Google Chrome` + `pid:24088` -> `Google Chrome (24088)`.
 * Left alone when the id is not a pid, so a future helper keyed on something
 * else cannot end up with a meaningless number stapled to its name.
 */
function withPid(name, id) {
  const match = /^pid:(\d+)$/.exec(String(id));
  return match ? `${name} (${match[1]})` : name;
}

/**
 * List applications the helper can capture.
 * Always resolves; an unavailable or misbehaving helper yields [] so the picker
 * falls back to whole-system capture.
 *
 * @returns {Promise<Array<{deviceId: string, label: string}>>}
 */
async function listAppSources({ spawn = nodeSpawn, resolvePath = resolveAudioHostPath } = {}) {
  const exe = resolvePath();
  if (!exe) {
    // Not an error on Linux, which has no helper. Everywhere else it means the
    // binary was never built - it is a build artifact, not a committed file -
    // and the only visible symptom would be a source list with nothing in it.
    if (process.platform !== 'linux') {
      console.warn(
        '[Sokuji] [AudioHost] Capture helper not found; per-application capture ' +
        'is unavailable. Run `npm run build:audio-host` (CI does this before packaging).'
      );
    }
    return [];
  }

  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(exe, ['--list']);
    } catch {
      return resolve([]);
    }

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      try {
        const rows = JSON.parse(out);
        if (!Array.isArray(rows)) return resolve([]);
        resolve(
          rows
            .filter((r) => r && typeof r.id === 'string')
            // appKey identifies the application across restarts, unlike the
            // pid inside deviceId. Windows reports an exe name, macOS a bundle
            // id; either is stable enough to re-find the app next launch.
            .map((r) => ({
              deviceId: `app:${r.id}`,
              // The pid rides in the name on every row, not only where two rows
              // would otherwise read alike. An application name is not unique -
              // a second Chrome profile is a second, separately capturable
              // Chrome - and a name that silently means "one of the two" is
              // worse than an ugly one. Composed here rather than in each
              // helper so Windows and macOS cannot drift apart; Linux taps
              // PipeWire nodes rather than processes and does not come through
              // this module at all.
              label: withPid(r.label || r.exe || r.id, r.id),
              appKey: r.exe || r.label || null,
              // A source is a process tree, and one tree can own several
              // windows that no OS here can capture separately. The row is
              // therefore named after the application, and its window titles
              // ride along for the UI to show on hover - otherwise two Chrome
              // windows look like one arbitrarily-chosen one. Absent on macOS,
              // where window titles cost the Screen Recording permission.
              windowTitles: Array.isArray(r.windows)
                ? r.windows.filter((t) => typeof t === 'string' && t.length > 0)
                : [],
            }))
        );
      } catch {
        resolve([]);
      }
    });
  });
}

/**
 * Start capturing one application.
 *
 * @param {string} deviceId  `app:pid:<n>` as produced by listAppSources
 * @param {(pcm: Buffer) => void} onPcm
 * @param {(event: object) => void} onEvent
 * @returns {boolean} false when the helper is unavailable
 */
function startCapture(deviceId, onPcm, onEvent, { spawn = nodeSpawn, resolvePath = resolveAudioHostPath } = {}) {
  const exe = resolvePath();
  if (!exe) return false;

  // Leaving a previous helper alive would mix two applications into one stream.
  stopCapture();

  // 'desktop-audio-loopback' is the renderer's whole-system sentinel; the
  // helper spells that 'system'. Routing it here means macOS whole-system
  // capture uses a global Core Audio tap, which needs only the audio-capture
  // permission - getDisplayMedia would demand Screen Recording as well.
  const raw = String(deviceId);
  const target = raw === 'desktop-audio-loopback' ? 'system' : raw.replace(/^app:/, '');
  let child;
  try {
    child = spawn(exe, ['--target', target]);
  } catch {
    return false;
  }

  current = child;

  // Only the helper that is still the current one may speak. kill() is
  // asynchronous - a killed child's `close` lands 1.5-2.2 ms later, measured -
  // and by then the renderer has finished switching sources: it has torn down
  // the old recorder and built a new one, already subscribed. PCM and events
  // all share one IPC channel per kind, so the late exit of the helper we
  // ourselves killed arrived at the *new* recorder, which read it as its own
  // helper dying and fell back to whole-system capture. Switching from one
  // application to another therefore captured every application, with the
  // picker still naming the one the user picked. Same for stdout: whatever was
  // buffered in the old pipe would be mixed into the new application's audio.
  const isCurrent = () => current === child;
  child.stdout.on('data', (d) => { if (isCurrent()) onPcm(d); });
  child.stderr.on('data', makeLineParser((evt) => { if (isCurrent()) onEvent(evt); }));
  child.on('error', (err) => {
    if (isCurrent()) onEvent({ event: 'error', code: 'spawn_failed', message: err.message });
  });
  child.on('close', (code) => {
    // A death we did not ask for is the only one worth reporting: that is what
    // tells the renderer its capture is gone.
    if (!isCurrent()) return;
    current = null;
    onEvent({ event: 'exit', code });
  });
  return true;
}

/** Stop any running capture. Safe to call when nothing is running. */
function stopCapture() {
  if (!current) return;
  try {
    current.kill();
  } catch {
    // Already exited.
  }
  current = null;
}

/**
 * Put a virtual device's volume back to unity, and unmute it.
 *
 * macOS stores that volume itself and restores it onto the driver, so it
 * survives reinstalling the driver - and a macOS 15 -> 26 upgrade was measured
 * leaving Sokuji's device at scalar 0.5, which the driver's logarithmic control
 * turns into -32 dB. The audio still flows, so nothing reports an error; the
 * other application simply hears silence. See the helper's --ensure-unity-gain
 * documentation for the measurement.
 *
 * Never throws and never rejects: this runs on the startup path, and a device
 * whose gain could not be checked must not be the reason the app fails to come
 * up. A null result means "could not tell", which the caller logs and moves on:
 * no helper, a helper too old to know the mode, output that is not the
 * documented object, or any non-zero exit - including a refused write, where
 * the helper has still printed a perfectly well-formed measurement.
 *
 * @param {string} deviceName  Substring matched against device names
 * @returns {Promise<{found: boolean, changed?: boolean, unmuted?: boolean,
 *                    before?: object, after?: object}|null>}
 */
async function ensureUnityGain(deviceName, { spawn = nodeSpawn, resolvePath = resolveAudioHostPath } = {}) {
  const exe = resolvePath();
  if (!exe) return null;

  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(exe, ['--ensure-unity-gain', deviceName]);
    } catch {
      return resolve(null);
    }

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      // The helper reports what it measured and *then* exits non-zero when a
      // write was refused, so the payload alone cannot be trusted: it would say
      // found, unchanged, which the caller reads as "already at unity" - the
      // same silent-success failure this whole path exists to remove. A signal
      // kill arrives here as a null code and is equally untrustworthy.
      if (code !== 0) return resolve(null);
      try {
        const result = JSON.parse(out);
        // An older shipped helper predates this mode and answers with its usage
        // text on stderr and nothing on stdout. Treat anything that is not the
        // documented object as "could not tell" rather than as a device that is
        // missing, which would send the caller down the not-installed path.
        if (!result || typeof result.found !== 'boolean') return resolve(null);
        resolve(result);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * List available native speech voices
 */
async function listSystemVoices({ spawn = nodeSpawn, resolvePath = resolveAudioHostPath } = {}) {
  const exe = resolvePath();
  if (!exe) return [];
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(exe, ['--list-voices']);
    } catch {
      return resolve([]);
    }
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', () => resolve([]));
    child.on('close', (code) => {
      if (code !== 0) return resolve([]);
      try {
        const rows = JSON.parse(out);
        resolve(Array.isArray(rows) ? rows : []);
      } catch {
        resolve([]);
      }
    });
  });
}

/**
 * Synthesize and play speech directly into the virtual microphone
 */
async function speakToVirtualMic(text, { lang = 'en-US', voice = '', device = '' } = {}, { spawn = nodeSpawn, resolvePath = resolveAudioHostPath } = {}) {
  const exe = resolvePath();
  if (!exe || !text) return false;
  const args = ['--speak', text, '--lang', lang];
  if (voice) args.push('--voice', voice);
  if (device) args.push('--device', device);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args);
    } catch {
      return resolve(false);
    }
    child.on('error', (err) => {
      console.error('[AudioHost] speakToVirtualMic error:', err);
      resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Play an audio file (e.g. from cloud TTS or WAV) into the virtual microphone
 */
async function playFileToVirtualMic(filePath, { device = '' } = {}, { spawn = nodeSpawn, resolvePath = resolveAudioHostPath } = {}) {
  const exe = resolvePath();
  if (!exe || !filePath) return false;
  const args = ['--play-file', filePath];
  if (device) args.push('--device', device);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args);
    } catch {
      return resolve(false);
    }
    child.on('error', (err) => {
      console.error('[AudioHost] playFileToVirtualMic error:', err);
      resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Test the virtual microphone by speaking a test sentence
 */
async function testVirtualMic({ device = '' } = {}, { spawn = nodeSpawn, resolvePath = resolveAudioHostPath } = {}) {
  const exe = resolvePath();
  if (!exe) return false;
  const args = ['--test-mic'];
  if (device) args.push('--device', device);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args);
    } catch {
      return resolve(false);
    }
    child.on('error', (err) => {
      console.error('[AudioHost] testVirtualMic error:', err);
      resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

let currentLocalSayProcess = null;

function stopLocalAudio() {
  if (currentLocalSayProcess) {
    try {
      currentLocalSayProcess.kill('SIGKILL');
    } catch {}
    currentLocalSayProcess = null;
  }
  return true;
}

/**
 * Play speech locally to the system default output (speakers/headphones) via macOS say command
 */
async function speakLocalAudio(text, { lang = 'en-US', voice = '' } = {}, { spawn = nodeSpawn } = {}) {
  stopLocalAudio();
  if (!text || !text.trim()) return false;

  if (process.platform === 'darwin') {
    let v = voice ? voice.replace(/^(system|ming):/, '').trim() : '';
    if (!v) {
      const base = (lang || 'en').split('-')[0].toLowerCase();
      v = (base === 'zh') ? 'Tingting' : 'Samantha';
    }
    // Map known aliases
    if (v === 'US_Emma' || v === 'UK_Charlotte') v = 'Samantha';
    else if (v === 'UK_George') v = 'Daniel';
    else if (v.startsWith('灵') || v === 'Ting-Ting') v = 'Tingting';

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('/usr/bin/say', ['-v', v, text.trim()]);
        currentLocalSayProcess = child;
      } catch {
        return resolve(false);
      }
      child.on('error', () => {
        if (currentLocalSayProcess === child) currentLocalSayProcess = null;
        resolve(false);
      });
      child.on('close', (code) => {
        if (currentLocalSayProcess === child) currentLocalSayProcess = null;
        resolve(code === 0);
      });
    });
  }
  return false;
}

module.exports = {
  listAppSources,
  startCapture,
  stopCapture,
  ensureUnityGain,
  listSystemVoices,
  speakToVirtualMic,
  playFileToVirtualMic,
  testVirtualMic,
  speakLocalAudio,
  stopLocalAudio
};
