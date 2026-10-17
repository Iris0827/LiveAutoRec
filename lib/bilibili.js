import { normalizeError, qualityLabel } from "./common.js";

const LIVE_API = "https://api.live.bilibili.com";
const COMMON_HEADERS = {
  Accept: "application/json, text/plain, */*"
};

export class BilibiliApiError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = "BilibiliApiError";
    this.code = code;
    this.status = status;
  }
}

export async function resolveShortUrl(url, signal) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    credentials: "omit",
    cache: "no-store",
    signal
  });
  if (!response.ok && !response.url) {
    throw new Error("短链接解析失败");
  }
  return response.url || url;
}

export async function fetchRoomMeta(roomId, signal) {
  const [roomData, anchorData] = await Promise.all([
    fetchJson(`${LIVE_API}/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`, { signal }),
    fetchJson(
      `${LIVE_API}/live_user/v1/UserInfo/get_anchor_in_room?roomid=${encodeURIComponent(roomId)}`,
      { signal }
    ).catch(() => null)
  ]);

  if (!roomData || !roomData.room_id) {
    throw new Error("没有查到该直播间");
  }

  return {
    roomId: Number(roomData.room_id),
    shortId: Number(roomData.short_id) || null,
    uid: Number(roomData.uid) || null,
    title: roomData.title || "B站直播",
    cover: roomData.user_cover || "",
    liveStatus: Number(roomData.live_status) === 1,
    liveTime: normalizeLiveTime(roomData.live_time),
    uname: anchorData?.info?.uname || "",
    face: anchorData?.info?.face || ""
  };
}

export async function fetchLiveStatus(roomId, signal) {
  const data = await fetchJson(
    `${LIVE_API}/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`,
    { signal }
  );
  return {
    roomId: Number(data.room_id),
    title: data.title || "B站直播",
    cover: data.user_cover || "",
    liveStatus: Number(data.live_status) === 1,
    liveTime: normalizeLiveTime(data.live_time)
  };
}

export async function fetchPlayUrl(roomId, requestedQn = 10000, signal) {
  const params = new URLSearchParams({
    room_id: String(roomId),
    protocol: "1",
    format: "1,2",
    codec: "0",
    qn: String(requestedQn),
    platform: "web",
    ptype: "8"
  });
  const data = await fetchJson(
    `${LIVE_API}/xlive/web-room/v2/index/getRoomPlayInfo?${params}`,
    { signal }
  );

  if (Number(data.live_status) !== 1) {
    return {
      live: false,
      liveTime: normalizeLiveTime(data.live_time)
    };
  }

  const playInfo = data.playurl_info?.playurl;
  if (!playInfo?.stream?.length) {
    throw new Error("直播已开播，但暂时没有拿到播放地址");
  }

  const candidates = [];
  for (const stream of playInfo.stream) {
    if (stream.protocol_name !== "http_hls") continue;
    for (const format of stream.format || []) {
      for (const codec of format.codec || []) {
        const host = codec.url_info?.[0]?.host;
        const extra = codec.url_info?.[0]?.extra || "";
        if (!host || !codec.base_url) continue;
        const normalizedHost = String(host).replace(/^http:/i, "https:");
        let url;
        try {
          url = new URL(codec.base_url, normalizedHost).href + extra;
        } catch {
          url = `${normalizedHost}${codec.base_url}${extra}`;
        }
        candidates.push({
          url,
          format: format.format_name,
          codec: codec.codec_name,
          qn: Number(codec.current_qn) || 0,
          session: codec.session || "",
          liveTime: normalizeLiveTime(data.live_time),
          height: Number(codec.media_info?.height) || 0,
          width: Number(codec.media_info?.width) || 0,
          bitrate: Number(codec.media_info?.realtime_avg_bw) || 0
        });
      }
    }
  }

  candidates.sort(compareCandidates);
  const selected = candidates[0];
  if (!selected) {
    throw new Error("没有找到可录制的 HLS 直播流");
  }

  const qnDescription = (playInfo.g_qn_desc || []).find(
    (item) => Number(item.qn) === selected.qn
  );

  return {
    live: true,
    url: selected.url,
    format: selected.format,
    codec: selected.codec,
    qn: selected.qn,
    quality: qnDescription?.desc || qualityLabel(selected.qn),
    session: selected.session,
    liveTime: selected.liveTime,
    height: selected.height,
    width: selected.width,
    bitrate: selected.bitrate,
    requestedQn
  };
}

function compareCandidates(left, right) {
  const formatScore = (value) => (value.format === "ts" ? 20 : value.format === "fmp4" ? 10 : 0);
  const codecScore = (value) => (value.codec === "avc" ? 20 : value.codec === "hevc" ? 5 : 0);
  const leftScore = formatScore(left) + codecScore(left);
  const rightScore = formatScore(right) + codecScore(right);
  if (leftScore !== rightScore) return rightScore - leftScore;
  if (left.qn !== right.qn) return right.qn - left.qn;
  return right.height - left.height;
}

async function fetchJson(url, { signal } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: COMMON_HEADERS,
      signal
    });
  } catch (error) {
    throw new BilibiliApiError(`连接 Bilibili 失败：${normalizeError(error).message}`);
  }

  if (!response.ok) {
    throw new BilibiliApiError(`Bilibili 返回 HTTP ${response.status}`, {
      status: response.status
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new BilibiliApiError("Bilibili 返回了无法解析的数据", {
      status: response.status
    });
  }

  if (Number(payload.code) !== 0) {
    throw new BilibiliApiError(payload.message || payload.msg || `接口错误 ${payload.code}`, {
      code: Number(payload.code),
      status: response.status
    });
  }
  return payload.data;
}

export async function fetchPlaylistText(url, signal) {
  let response;
  try {
    response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      signal
    });
  } catch (error) {
    throw new Error(`读取直播列表失败：${normalizeError(error).message}`);
  }
  if (!response.ok) {
    throw new Error(`直播列表 HTTP ${response.status}`);
  }
  return response.text();
}

export async function fetchSegment(url, signal) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    signal
  });
  if (!response.ok) {
    throw new Error(`分片 HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function isExpiredStreamError(error) {
  return /HTTP (403|404|410)/i.test(error?.message || "");
}

function normalizeLiveTime(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value > 0 ? value : 0;
  if (/^\d+(?:\.\d+)?$/.test(String(value))) return Number(value);
  const match = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/
  );
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match;
  // Room/get_info returns Beijing wall-clock time without an offset.
  const timestamp = Date.parse(
    `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`
  );
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}
