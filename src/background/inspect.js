// Reads stream manifests so the popup can offer real quality choices.
import { parseM3U8 } from '../shared/hls.js';
import { dedupeKey, formatBitrate, qualityLabel, uid } from '../shared/media.js';
import { withHeaders } from './headers.js';

async function fetchText(url, referer) {
  return withHeaders({ url, referer }, async () => {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });
}

function audioLabel(m) {
  return [m.name, m.language && m.name !== m.language ? m.language : ''].filter(Boolean).join(' · ') || 'Audio';
}

/**
 * Inspect an HLS playlist. Returns the extra fields for the media item:
 * variants (quality choices), duration, live, drm, childKeys.
 */
export async function inspectHls(url, referer) {
  const text = await fetchText(url, referer);
  const pl = parseM3U8(text, url);

  if (pl.type === 'media') {
    // A single-quality playlist (no master).
    return {
      variants: [{ id: uid(), label: 'Source', url, height: 0, bandwidth: 0 }],
      duration: pl.duration,
      live: pl.live,
      drm: pl.drm,
      encrypted: pl.encrypted,
      fmp4: pl.fmp4,
      isMediaPlaylist: true,
    };
  }

  const audioGroups = pl.media.filter((m) => m.type === 'AUDIO' && m.uri);
  const pickAudio = (groupId) => {
    const group = audioGroups.filter((m) => m.groupId === groupId);
    return group.find((m) => m.isDefault) || group[0] || null;
  };

  // Some masters also list the audio rendition as a "variant" (no resolution,
  // audio-only codecs). With audio groups present it's covered by the
  // "Audio only" chips; otherwise it becomes one.
  const isAudioVariant = (v) => !v.height && !!v.codecs && !/avc|hvc|hev|vp0?[89]|av01|dvh|mp4v/i.test(v.codecs);
  const audioVariants = pl.variants.filter(isAudioVariant);

  const seenLabels = new Map();
  const variants = pl.variants
    .filter((v) => (v.height || v.bandwidth) && !isAudioVariant(v))
    .map((v) => {
      const audio = v.audio ? pickAudio(v.audio) : null;
      const base = qualityLabel(v.height, v.width) || formatBitrate(v.bandwidth) || 'Stream';
      // Two 720p variants (e.g. 30 and 60 fps) need distinct labels.
      const n = (seenLabels.get(base) || 0) + 1;
      seenLabels.set(base, n);
      return {
        id: uid(),
        label: base,
        dup: n,
        url: v.uri,
        audioUrl: audio?.uri || '',
        audioName: audio ? audioLabel(audio) : '',
        height: v.height,
        width: v.width,
        bandwidth: v.bandwidth,
        frameRate: v.frameRate,
        codecs: v.codecs,
      };
    });
  for (const v of variants) {
    if (seenLabels.get(v.label) > 1) {
      v.label = v.frameRate > 30 ? `${v.label}${Math.round(v.frameRate)}` : `${v.label} · ${formatBitrate(v.bandwidth)}`;
    }
    delete v.dup;
  }

  // Offer audio-only downloads when the stream has separate audio tracks.
  const audioOnly = [];
  const seenAudio = new Set();
  for (const m of audioGroups) {
    if (seenAudio.has(m.uri)) continue;
    seenAudio.add(m.uri);
    audioOnly.push({ id: uid(), label: 'Audio only', sub: audioLabel(m), url: m.uri, audioOnly: true, height: 0, bandwidth: 0 });
  }
  if (!audioOnly.length && audioVariants.length) {
    const best = audioVariants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
    audioOnly.push({ id: uid(), label: 'Audio only', sub: formatBitrate(best.bandwidth), url: best.uri, audioOnly: true, height: 0, bandwidth: best.bandwidth });
  }

  // Duration and DRM live in the media playlists; read the best one.
  let duration = 0;
  let live = false;
  let drm = pl.drm;
  let encrypted = false;
  let fmp4 = false;
  if (variants[0]) {
    try {
      const child = parseM3U8(await fetchText(variants[0].url, referer), variants[0].url);
      if (child.type === 'media') {
        ({ duration, live, encrypted, fmp4 } = child);
        drm = drm || child.drm;
      }
    } catch { /* duration is nice-to-have */ }
  }

  const childKeys = [...pl.variants.map((v) => dedupeKey(v.uri)), ...pl.media.filter((m) => m.uri).map((m) => dedupeKey(m.uri))];
  const allVariants = variants.length ? variants : [{ id: uid(), label: 'Source', url, height: 0, bandwidth: 0 }];
  return { variants: [...allVariants, ...audioOnly.slice(0, 4)], duration, live, drm, encrypted, fmp4, childKeys };
}

/** Light-weight MPD reader (no DOMParser in service workers). */
export async function inspectDash(url, referer) {
  const xml = await fetchText(url, referer);
  const drm = /<ContentProtection[^>]+(?:edef8ba9|9a04f079|94ce86fb|urn:mpeg:dash:mp4protection)/i.test(xml);
  const durMatch = /mediaPresentationDuration="PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?"/.exec(xml);
  const duration = durMatch ? (+durMatch[1] || 0) * 3600 + (+durMatch[2] || 0) * 60 + (+durMatch[3] || 0) : 0;
  const heights = new Set();
  for (const m of xml.matchAll(/<Representation\b[^>]*\bheight="(\d+)"/g)) heights.add(+m[1]);
  const variants = [...heights].sort((a, b) => b - a).map((h) => ({ id: uid(), label: qualityLabel(h), height: h, url }));
  return { variants, duration, live: /type="dynamic"/.test(xml), drm };
}
