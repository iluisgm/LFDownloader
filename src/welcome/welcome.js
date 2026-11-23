import { api } from '../shared/api.js';
import { LOGO } from '../shared/icons.js';
import { $, hydrateIcons, toast } from '../shared/ui.js';
import { getSettings, applyTheme } from '../shared/settings.js';

(async () => {
  applyTheme(await getSettings());
  $('#logo').outerHTML = LOGO;
  hydrateIcons();

  const check = async () => {
    $('#perm').hidden = await api.permissions.contains({ origins: ['<all_urls>'] });
  };
  await check();
  $('#grant').onclick = async () => {
    if (await api.permissions.request({ origins: ['<all_urls>'] })) toast('Access granted — you are all set');
    check();
  };
  // The hls.js demo player with a public test stream (Big Buck Bunny, CC-BY).
  const stream = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  $('#open-demo').onclick = () => api.tabs.create({ url: `https://hlsjs.video-dev.org/demo/?src=${encodeURIComponent(stream)}` });
  $('#open-settings').onclick = () => api.runtime.openOptionsPage();
})();
