import test from "node:test";
import assert from "node:assert/strict";
import {
  formatBytes,
  formatDuration,
  makeRecordingFilename,
  recordingPartSuffix,
  parseRoomInput,
  sanitizeFilename,
  shouldStartNewRecordingPart
} from "../lib/common.js";

test("parse direct live room URLs", () => {
  assert.equal(
    parseRoomInput("https://live.bilibili.com/12345?broadcast_type=0").roomId,
    12345
  );
  assert.equal(parseRoomInput("https://live.bilibili.com/blanc/9988").roomId, 9988);
  assert.equal(parseRoomInput("https://live.bilibili.com/h5/777").roomId, 777);
});

test("parse room IDs and b23 links", () => {
  assert.equal(parseRoomInput("12345").roomId, 12345);
  assert.equal(parseRoomInput("https://b23.tv/abcd").kind, "shortUrl");
});

test("reject unrelated sites", () => {
  assert.throws(() => parseRoomInput("https://example.com/12345"));
});

test("sanitize Windows file names", () => {
  assert.equal(sanitizeFilename('a<b>c:"d/e\\f|g?h*i'), "a b c d e f g h i");
  assert.equal(sanitizeFilename("CON"), "_CON");
  assert.equal(sanitizeFilename("..."), "直播录像");
});

test("format duration and bytes", () => {
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(3661), "1:01:01");
  assert.equal(formatBytes(1536), "1.50 KB");
});

test("build a useful recording filename", () => {
  const name = makeRecordingFilename({
    roomId: 123,
    uname: "测试主播",
    title: "今晚聊聊天",
    liveTime: 1700000000
  });
  assert.match(name, /^\[测试主播\]今晚聊聊天\[\d{4}-\d{2}-\d{2}\]\.avi$/);
});

test("start a new recording part after two hours", () => {
  assert.equal(recordingPartSuffix(1), "");
  assert.equal(recordingPartSuffix(2), "_P2");
  assert.equal(recordingPartSuffix(3), "_P3");
  assert.equal(shouldStartNewRecordingPart(7198, 3), true);
  assert.equal(shouldStartNewRecordingPart(7197, 3), false);
  assert.equal(shouldStartNewRecordingPart(0, 3), false);
});
