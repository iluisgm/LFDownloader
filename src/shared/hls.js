// Minimal, dependency-free HLS (m3u8) playlist parser.
// Covers master playlists, media playlists, byte ranges, EXT-X-MAP (fMP4),
// EXT-X-KEY and discontinuities — what is needed to rebuild a file.

/** Parse an attribute list: KEY=VALUE,KEY="quoted, value" */
export function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

function resolve(uri, base) {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

function parseByteRange(value, prevEnd) {
  const [len, off] = value.split('@');
  const length = parseInt(len, 10);
  const offset = off !== undefined ? parseInt(off, 10) : prevEnd;
  return { length, offset: offset || 0 };
}

const DRM_KEYFORMATS = [
  'com.widevine', 'urn:uuid:edef8ba9', // Widevine
  'com.apple.streamingkeydelivery', // FairPlay
  'com.microsoft.playready', 'urn:uuid:9a04f079', // PlayReady
];

export function isDrmKey(key) {
  if (!key || key.method === 'NONE') return false;
  if (key.method === 'SAMPLE-AES' || key.method === 'SAMPLE-AES-CTR' || key.method === 'SAMPLE-AES-CENC') return true;
  const fmt = (key.keyformat || '').toLowerCase();
  return DRM_KEYFORMATS.some((d) => fmt.startsWith(d));
}

export function parseM3U8(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  const media = [];
  const sessionKeys = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice(18));
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) { uri = lines[j]; i = j; break; }
      }
      if (!uri) continue;
      const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
      variants.push({
        uri: resolve(uri, baseUrl),
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
        peakBandwidth: Number(a.BANDWIDTH) || 0,
        width: w || 0,
        height: h || 0,
        codecs: a.CODECS || '',
        frameRate: Number(a['FRAME-RATE']) || 0,
        audio: a.AUDIO || '',
        name: a.NAME || '',
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      media.push({
        type: a.TYPE,
        groupId: a['GROUP-ID'],
        name: a.NAME || a.LANGUAGE || '',
        language: a.LANGUAGE || '',
        uri: a.URI ? resolve(a.URI, baseUrl) : '',
        isDefault: a.DEFAULT === 'YES',
      });
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      const a = parseAttrs(line.slice(19));
      sessionKeys.push({ method: a.METHOD, keyformat: a.KEYFORMAT || '' });
    }
  }
  // Drop exact duplicates (backup streams) and audio-only variants listed as video.
  const seen = new Set();
  const unique = variants.filter((v) => (seen.has(v.uri) ? false : seen.add(v.uri)));
  unique.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  return {
    type: 'master',
    variants: unique,
    media,
    drm: sessionKeys.some(isDrmKey),
  };
}

function parseMedia(lines, baseUrl) {
  const segments = [];
  let duration = 0;
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let key = null;
  let map = null;
  let byterange = null;
  let discontinuity = false;
  let prevRangeEnd = {};
  let segDuration = 0;
  let drm = false;
  let playlistType = '';

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      segDuration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice(21);
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byterange = line.slice(17);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      key = a.METHOD === 'NONE' ? null : {
        method: a.METHOD,
        uri: a.URI ? resolve(a.URI, baseUrl) : '',
        iv: a.IV || '',
        keyformat: a.KEYFORMAT || '',
      };
      if (isDrmKey(key)) drm = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      const uri = resolve(a.URI, baseUrl);
      map = { uri, byterange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (!line.startsWith('#')) {
      const uri = resolve(line, baseUrl);
      let range = null;
      if (byterange) {
        range = parseByteRange(byterange, prevRangeEnd[uri] || 0);
        prevRangeEnd[uri] = range.offset + range.length;
      }
      segments.push({
        uri,
        duration: segDuration,
        seq: mediaSequence + segments.length,
        byterange: range,
        key,
        map,
        discontinuity,
      });
      duration += segDuration;
      segDuration = 0;
      byterange = null;
      discontinuity = false;
    }
  }

  return {
    type: 'media',
    segments,
    duration,
    targetDuration,
    mediaSequence,
    live: !endList && playlistType !== 'VOD',
    fmp4: segments.some((s) => s.map),
    encrypted: segments.some((s) => s.key),
    drm,
  };
}
