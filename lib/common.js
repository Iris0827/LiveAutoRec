export const ROOM_URL_PREFIX = "https://live.bilibili.com/";
export const MAX_RECORDING_PART_SECONDS = 2 * 60 * 60;

export function parseRoomInput(rawInput) {
  const input = String(rawInput ?? "").trim();
  if (!input) {
    throw new Error("请输入直播间地址或房间号");
  }

  if (/^\d+$/.test(input)) {
    return {
      kind: "room",
      roomId: Number(input),
      input,
      roomUrl: ROOM_URL_PREFIX + input
    };
  }

  let url;
  try {
    url = new URL(input, "https://live.bilibili.com/");
  } catch {
    throw new Error("无法识别这个直播间地址");
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "b23.tv" || hostname.endsWith(".b23.tv")) {
    return { kind: "shortUrl", input, url: url.href };
  }

  if (
    hostname !== "live.bilibili.com" &&
    hostname !== "www.bilibili.com" &&
    hostname !== "bilibili.com"
  ) {
    throw new Error("请粘贴 Bilibili 直播间地址，例如 https://live.bilibili.com/12345");
  }

  const roomIdFromQuery = url.searchParams.get("room_id");
  if (roomIdFromQuery && /^\d+$/.test(roomIdFromQuery)) {
    return makeRoomResult(Number(roomIdFromQuery), input);
  }

  const match = url.pathname.match(
    /^\/(?:blanc\/|h5\/|blackboard\/room\/)?(\d+)(?:\/|$)/i
  );
  if (match) {
    return makeRoomResult(Number(match[1]), input);
  }

  throw new Error("这个地址里没有识别到直播间房间号");
}

function makeRoomResult(roomId, input) {
  return {
    kind: "room",
    roomId,
    input,
    roomUrl: ROOM_URL_PREFIX + roomId
  };
}

export function sanitizeFilename(value, fallback = "直播录像", maxLength = 96) {
  let name = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  if (!name) {
    name = fallback;
  }

  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (reserved.test(name)) {
    name = "_" + name;
  }

  if (name.length > maxLength) {
    name = name.slice(0, maxLength).replace(/[. ]+$/g, "");
  }

  return name || fallback;
}

export function makeRecordingFilename({ roomId, uname, title, liveTime }, extension = "avi") {
  const date = new Date(Number(liveTime) > 0 ? Number(liveTime) * 1000 : Date.now());
  const dateLabel = formatLocalDate(date);
  const channel = sanitizeFilename(uname || `房间${roomId}`, `房间${roomId}`, 48);
  const streamTitle = sanitizeFilename(title || "直播", "直播", 96);
  return `[${channel}]${streamTitle}[${dateLabel}].${extension}`;
}

export function recordingPartSuffix(partNumber) {
  return partNumber > 1 ? `_P${partNumber}` : "";
}

export function shouldStartNewRecordingPart(currentSeconds, nextSegmentSeconds) {
  const current = Math.max(0, Number(currentSeconds) || 0);
  const next = Math.max(0, Number(nextSegmentSeconds) || 0);
  return current > 0 && current + next > MAX_RECORDING_PART_SECONDS;
}

export function formatLocalDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatLocalDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + "_" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("-");
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let number = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && number >= 1024; index += 1) {
    number /= 1024;
    unit = units[index];
  }
  const digits = number >= 100 ? 0 : number >= 10 ? 1 : 2;
  return `${number.toFixed(digits)} ${unit}`;
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`;
}

export function delay(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createAbortError() {
  const error = new Error("操作已取消");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}

export function normalizeError(error) {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeTaskId() {
  return crypto.randomUUID();
}

export function qualityLabel(qn) {
  const value = Number(qn);
  if (value >= 20000) return "4K";
  if (value >= 15000) return "2K";
  if (value >= 10000) return "1080P 原画";
  if (value >= 400) return "1080P";
  if (value >= 250) return "720P";
  if (value >= 150) return "480P";
  if (value >= 80) return "流畅";
  return value > 0 ? `画质 ${value}` : "未知画质";
}
