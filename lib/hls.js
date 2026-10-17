import { clamp } from "./common.js";

export function parseHlsPlaylist(text, playlistUrl) {
  const normalized = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("#EXTM3U")) {
    throw new Error("服务器返回的不是有效 HLS 播放列表");
  }

  if (/^#EXT-X-STREAM-INF:/m.test(normalized)) {
    return parseMasterPlaylist(normalized, playlistUrl);
  }
  return parseMediaPlaylist(normalized, playlistUrl);
}

function splitLines(text) {
  return text.split("\n").map((line) => line.trim());
}

function parseMasterPlaylist(text, playlistUrl) {
  const lines = splitLines(text);
  const variants = [];
  let pending = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pending = line.slice("#EXT-X-STREAM-INF:".length);
      continue;
    }
    if (line && !line.startsWith("#") && pending) {
      variants.push({
        attributes: pending,
        url: resolveUri(line, playlistUrl)
      });
      pending = null;
    }
  }

  if (!variants.length) {
    throw new Error("主播放列表中没有可用码流");
  }
  return { kind: "master", variants };
}

function parseMediaPlaylist(text, playlistUrl) {
  const lines = splitLines(text);
  const mediaSequence = readIntegerTag(lines, "#EXT-X-MEDIA-SEQUENCE:", 0);
  const targetDuration = readIntegerTag(lines, "#EXT-X-TARGETDURATION:", 3);
  const segments = [];
  let duration = 0;
  let mapUri = null;
  let discontinuity = 0;
  let programDateTime = null;
  let index = 0;

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith("#EXT-X-MAP:")) {
      mapUri = parseAttribute(line.slice("#EXT-X-MAP:".length), "URI");
      continue;
    }
    if (line === "#EXT-X-DISCONTINUITY") {
      discontinuity += 1;
      continue;
    }
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      programDateTime = line.slice("#EXT-X-PROGRAM-DATE-TIME:".length);
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const value = Number.parseFloat(line.slice("#EXTINF:".length).split(",")[0]);
      duration = Number.isFinite(value) ? value : 0;
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }

    const url = resolveUri(line, playlistUrl);
    segments.push({
      id: `${mediaSequence + index}:${basenameFromUrl(url)}`,
      sequence: mediaSequence + index,
      duration,
      discontinuity,
      programDateTime,
      url,
      mapUrl: mapUri ? resolveUri(mapUri, playlistUrl) : null
    });
    index += 1;
  }

  return {
    kind: "media",
    mediaSequence,
    targetDuration: clamp(targetDuration || 3, 1, 30),
    segments,
    ended: lines.includes("#EXT-X-ENDLIST")
  };
}

function readIntegerTag(lines, prefix, fallback) {
  const line = lines.find((value) => value.startsWith(prefix));
  if (!line) return fallback;
  const value = Number.parseInt(line.slice(prefix.length), 10);
  return Number.isFinite(value) ? value : fallback;
}

function parseAttribute(attributes, key) {
  const pattern = new RegExp(`${key}=(?:"([^"]*)"|([^,]*))`, "i");
  const match = String(attributes).match(pattern);
  return match ? (match[1] ?? match[2] ?? "") : null;
}

function resolveUri(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    throw new Error("播放列表中的分片地址无效");
  }
}

function basenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
  } catch {
    return url;
  }
}

export function selectNewSegments(playlist, recordingState) {
  if (!playlist.segments.length) return [];
  const saved = recordingState.savedSegmentIds;
  const result = [];

  for (const segment of playlist.segments) {
    if (saved.has(segment.id)) continue;
    result.push(segment);
  }

  return result;
}

export function updateSequenceGap(recordingState, firstSequence) {
  if (!Number.isFinite(firstSequence)) return 0;
  if (!Number.isFinite(recordingState.lastSequence)) {
    recordingState.lastSequence = firstSequence;
    return 0;
  }
  const gap = firstSequence - recordingState.lastSequence - 1;
  recordingState.lastSequence = Math.max(recordingState.lastSequence, firstSequence);
  return Math.max(0, gap);
}

export function playlistPollInterval(targetDuration) {
  return clamp(Math.round((targetDuration || 3) * 400), 700, 1600);
}
