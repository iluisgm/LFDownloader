#!/usr/bin/env node
// Generates test media with ffmpeg into test/fixtures/media (git-ignored).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'media');
const ffIn = (cwd, ...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit', cwd });
const ff = (...args) => ffIn(dir, ...args);
const src = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12'];

mkdirSync(dir, { recursive: true });

if (!existsSync(join(dir, 'sample.mp4'))) {
  ff(...src, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', join(dir, 'sample.mp4'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-c:a', 'libmp3lame', '-b:a', '192k', join(dir, 'song.mp3'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=550:duration=4', join(dir, 'tone.wav'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.3', join(dir, 'beep.mp3')); // must be ignored (tiny)
}

// Multi-quality HLS (MPEG-TS) with a master playlist.
const hls = join(dir, 'hls');
mkdirSync(hls, { recursive: true });
ff(...src,
  '-filter_complex', '[0:v]split=2[a][b];[a]scale=1280:720[v720];[b]scale=640:360[v360]',
  '-map', '[v720]', '-map', '1:a', '-map', '[v360]', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  '-b:v:0', '2500k', '-b:v:1', '700k', '-g', '60', '-sc_threshold', '0',
  '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(hls, 'v%v_%03d.ts'),
  '-master_pl_name', 'master.m3u8', '-var_stream_map', 'v:0,a:0 v:1,a:1', join(hls, 'v%v.m3u8'));

// AES-128 encrypted HLS.
const aes = join(dir, 'hls-aes');
mkdirSync(aes, { recursive: true });
writeFileSync(join(aes, 'key.bin'), randomBytes(16));
writeFileSync(join(aes, 'keyinfo.txt'), `key.bin\n${join(aes, 'key.bin')}\n`);
ff(...src, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-vf', 'scale=854:480', '-c:a', 'aac',
  '-f', 'hls', '-hls_time', '3', '-hls_playlist_type', 'vod', '-hls_key_info_file', join(aes, 'keyinfo.txt'),
  '-hls_segment_filename', join(aes, 'seg_%03d.ts'), join(aes, 'index.m3u8'));

// fMP4 HLS (EXT-X-MAP init segment).
const fmp4 = join(dir, 'hls-fmp4');
mkdirSync(fmp4, { recursive: true });
// ffmpeg writes the init segment relative to its working directory.
ffIn(fmp4, ...src, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-vf', 'scale=1920:1080', '-c:a', 'aac',
  '-f', 'hls', '-hls_time', '3', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
  '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(fmp4, 'chunk_%03d.m4s'), join(fmp4, 'stream.m3u8'));

// HLS with a separate audio rendition (EXT-X-MEDIA TYPE=AUDIO), common on real sites.
const split = join(dir, 'hls-split');
mkdirSync(split, { recursive: true });
ffIn(split, ...src,
  '-filter_complex', '[0:v]split=2[a][b];[a]scale=1280:720[v720];[b]scale=640:360[v360]',
  '-map', '[v720]', '-map', '[v360]', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  '-b:v:0', '2500k', '-b:v:1', '700k', '-g', '60', '-sc_threshold', '0',
  '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', 's%v_%03d.ts',
  '-master_pl_name', 'master.m3u8', '-var_stream_map', 'v:0,agroup:aud v:1,agroup:aud a:0,agroup:aud,name:English', 's%v.m3u8');

// Gallery: 10 full-size photos (1600x1200) and their thumbnails (240x180).
const img = join(dir, 'img');
mkdirSync(join(img, 'full'), { recursive: true });
mkdirSync(join(img, 'thumbs'), { recursive: true });
const hues = [0, 36, 72, 108, 144, 180, 216, 252, 288, 324];
hues.forEach((h, i) => {
  const n = i + 1;
  const full = join(img, 'full', `photo${n}.jpg`);
  ff('-f', 'lavfi', '-i', `testsrc2=size=1600x1200:duration=1,hue=h=${h}`, '-frames:v', '1', '-q:v', '3', full);
  ff('-i', full, '-vf', 'scale=240:180', '-q:v', '5', join(img, 'thumbs', `photo${n}_t.jpg`));
});
ff('-f', 'lavfi', '-i', 'color=c=red:size=64x64:duration=1', '-frames:v', '1', join(img, 'logo.png'));

console.log('✔ fixtures in', dir);
