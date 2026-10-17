import test from "node:test";
import assert from "node:assert/strict";
import {
  parseHlsPlaylist,
  playlistPollInterval,
  selectNewSegments,
  updateSequenceGap
} from "../lib/hls.js";

test("parse a Bilibili TS media playlist", () => {
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:42
#EXT-X-TARGETDURATION:3
#EXTINF:3.000, no desc
live-42.ts
#EXTINF:3.000, no desc
live-43.ts
`;
  const playlist = parseHlsPlaylist(
    text,
    "https://cdn.example.com/live/index.m3u8?token=1"
  );
  assert.equal(playlist.kind, "media");
  assert.equal(playlist.targetDuration, 3);
  assert.equal(playlist.segments.length, 2);
  assert.equal(playlist.segments[0].sequence, 42);
  assert.equal(playlist.segments[0].url, "https://cdn.example.com/live/live-42.ts");
});

test("parse master playlists", () => {
  const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720
720p/index.m3u8
`;
  const playlist = parseHlsPlaylist(text, "https://cdn.example.com/live/master.m3u8");
  assert.equal(playlist.kind, "master");
  assert.equal(playlist.variants[0].url, "https://cdn.example.com/live/720p/index.m3u8");
});

test("select only new segments", () => {
  const playlist = parseHlsPlaylist(
    `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-TARGETDURATION:2
#EXTINF:2,
a.ts
#EXTINF:2,
b.ts
`,
    "https://cdn.example.com/live.m3u8"
  );
  const state = { savedSegmentIds: new Set([playlist.segments[0].id]) };
  const selected = selectNewSegments(playlist, state);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sequence, 6);
});

test("sequence gaps and polling interval", () => {
  const state = { lastSequence: 10 };
  assert.equal(updateSequenceGap(state, 14), 3);
  assert.equal(state.lastSequence, 14);
  assert.equal(playlistPollInterval(3), 1200);
  assert.equal(playlistPollInterval(0.5), 700);
});
