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
