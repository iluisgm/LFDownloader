// Sites whose videos can't be taken from network traffic, so they go through
// the yt-dlp helper instead.

const YT_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i;

/** The 11-character video ID of a YouTube watch/shorts/embed/youtu.be link, or ''. */
export function youtubeId(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const ok = (id) => (/^[\w-]{11}$/.test(id || '') ? id : '');
  if (/^youtu\.be$/i.test(u.hostname)) return ok(u.pathname.split('/')[1]);
  if (!YT_HOSTS.test(u.hostname)) return '';
  if (u.pathname === '/watch') return ok(u.searchParams.get('v'));
  const m = u.pathname.match(/^\/(shorts|embed|live|v|e)\/([\w-]{11})/);
  return m ? ok(m[2]) : '';
}

export const youtubeUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
export const youtubeThumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/** Media item for a YouTube video found on a page (qualities are read later, by the helper). */
export function youtubeItem(id, { pageUrl, title = '' }) {
  return {
    key: `yt:${id}`, videoId: id, source: 'ytdlp', site: 'YouTube',
    kind: 'video', format: 'youtube', url: youtubeUrl(id), pageUrl, title,
    poster: youtubeThumb(id), variants: [], size: 0,
  };
}

const X_HOSTS = /(^|\.)(x\.com|twitter\.com)$/i;

/** The numeric ID of an X/Twitter post link (x.com/user/status/123…), or ''. */
export function xStatusId(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  if (!X_HOSTS.test(u.hostname)) return '';
  const m = u.pathname.match(/^\/(?:[\w]{1,15}|i(?:\/web)?)\/status(?:es)?\/(\d{5,25})/);
  return m ? m[1] : '';
}

/** Media item for a video in an X post (downloaded with yt-dlp as one MP4). */
export function xItem(id, { pageUrl, title = '', poster = '', user = '' }) {
  return {
    key: `x:${id}`, statusId: id, source: 'ytdlp', site: 'X',
    kind: 'video', format: 'x', url: `https://x.com/${user || 'i'}/status/${id}`, pageUrl, title,
    poster, variants: [], size: 0,
  };
}
