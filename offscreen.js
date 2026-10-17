import {
  delay,
  formatBytes,
  isAbortError,
  makeRecordingFilename,
  normalizeError,
  nowIso,
  recordingPartSuffix,
  shouldStartNewRecordingPart
} from "./lib/common.js";
import {
  fetchLiveStatus,
  fetchPlayUrl,
  fetchPlaylistText,
  fetchSegment,
  isExpiredStreamError
} from "./lib/bilibili.js";
import {
  parseHlsPlaylist,
  playlistPollInterval,
  selectNewSegments,
  updateSequenceGap
} from "./lib/hls.js";
import {
  createRecordingSink,
  deleteTemporaryFile,
  mimeTypeForName,
  OPFS_FOLDER,
  listTemporaryRecordings,
  readRecordingSinkFile,
  writeAviOutput
} from "./lib/file-store.js";
import { remuxToAvi } from "./lib/avi-converter.js";

const controllers = new Map();
let settings = {
  quality: "best",
  requestedQn: 20000,
  saveMode: "download",
  directoryName: "",
  notify: true
};
let shuttingDown = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  handleOffscreenMessage(message)
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((error) => {
      console.warn("Offscreen command failed", message?.type, error);
      sendResponse({ ok: false, error: normalizeError(error).message });
    });
  return true;
});

notify("REQUEST_SYNC").catch(() => {});
recoverOrphanedRecordings().catch((error) => {
  console.warn("Could not recover temporary recordings", error);
});

async function handleOffscreenMessage(message) {
  switch (message.type) {
    case "SYNC_STATE":
      await syncState(message.state);
      return {};
    case "STOP_TASK":
      await stopTask(message.taskId, message.reason || "stopped");
      return {};
    case "SHUTDOWN":
      await shutdown();
      return {};
    case "PING":
      return { alive: true };
    default:
      throw new Error("未知后台命令");
  }
}

async function syncState(state) {
  if (!state) return;
  settings = {
    ...settings,
    ...(state.settings || {})
  };
  shuttingDown = false;

  const nextTasks = new Map(
    (state.tasks || [])
      .filter((task) => task.enabled)
      .map((task) => [task.id, task])
  );

  for (const [taskId, controller] of controllers.entries()) {
    if (!nextTasks.has(taskId)) {
      await controller.stop("removed");
      controllers.delete(taskId);
    }
  }

  for (const [taskId, task] of nextTasks.entries()) {
    const existing = controllers.get(taskId);
    if (existing) {
      existing.task = task;
    } else {
      const controller = new TaskController(task);
      controllers.set(taskId, controller);
      controller.start();
    }
  }
}

async function stopTask(taskId, reason) {
  const controller = controllers.get(taskId);
  if (!controller) return;
  controllers.delete(taskId);
  await controller.stop(reason);
}

async function shutdown() {
  shuttingDown = true;
  const running = [...controllers.values()];
  controllers.clear();
  await Promise.allSettled(running.map((controller) => controller.stop("shutdown")));
}

class TaskController {
  constructor(task) {
    this.task = task;
    this.running = false;
    this.abortController = null;
    this.stopReason = "";
    this.loopPromise = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.loopPromise = this.runLoop();
  }

  async stop(reason) {
    this.stopReason = reason;
    this.running = false;
    this.abortController?.abort();
    try {
      await this.loopPromise;
    } catch (error) {
      if (!isAbortError(error)) {
        console.warn("Task loop stopped with error", error);
      }
    }
  }

  async runLoop() {
    let failureCount = 0;
    while (this.running && !shuttingDown) {
      try {
        await this.checkAndRecord();
        failureCount = 0;
      } catch (error) {
        if (isAbortError(error) || !this.running || shuttingDown) break;
        failureCount += 1;
        const message = normalizeError(error).message;
        await this.patch({
          status: "error",
          statusText: "连接失败，正在重试",
          lastError: message
        });
        await notifyBackground("RECORDER_NOTICE", {
          taskId: this.task.id,
          noticeType: "error",
          error: message
        });
        await delay(Math.min(30000, 3000 * failureCount), this.abortController.signal);
      }
    }
  }

  async checkAndRecord() {
    const live = await fetchLiveStatus(this.task.roomId, this.abortController.signal);
    this.task = { ...this.task, ...live };
    await this.patch({
      title: live.title,
      cover: live.cover,
      liveStatus: live.liveStatus,
      liveTime: live.liveTime,
      lastCheckedAt: nowIso(),
      lastError: "",
      ...(live.liveStatus
        ? {
            status: "recording",
            statusText: "正在准备录制"
          }
        : {
            status: "waiting",
            statusText: "等待开播"
          })
    });

    if (!live.liveStatus) {
      await delay(30000, this.abortController.signal);
      return;
    }

    await this.recordSession(live);
  }

  async recordSession(live) {
    let play = await this.refreshPlayUrl();
    if (!play.live) {
      await delay(5000, this.abortController.signal);
      return;
    }

    const baseFileName = makeRecordingFilename(
      {
        roomId: this.task.roomId,
        uname: this.task.uname,
        title: live.title || this.task.title,
        liveTime: play.liveTime || live.liveTime
      },
      "avi"
    ).replace(/\.avi$/i, "");
    const recordingState = {
      liveTime: play.liveTime || live.liveTime,
      session: play.session || "",
      format: play.format,
      nativeExtension: play.format === "fmp4" ? "mp4" : "ts",
      baseFileName,
      savedSegmentIds: new Set(),
      lastSequence: null,
      activePart: null,
      partNumber: 0,
      parts: [],
      outputFiles: [],
      bytes: 0,
      outputBytes: 0,
      segments: 0,
      durationSec: 0,
      gaps: 0,
      lastPatchAt: 0,
      conversionChain: Promise.resolve(),
      conversionError: ""
    };

    await this.beginPart(recordingState);
    await this.patch({
      status: "recording",
      statusText: "正在录制，结束后自动转换 AVI",
      currentFileName: recordingState.activePart.targetFileName,
      quality: play.quality,
      qualityQn: play.qn,
      resolution: play.height ? `${play.width}×${play.height}` : "",
      saveMode: recordingState.activePart.sink.mode,
      saveLocation: recordingState.activePart.sink.pathLabel,
      bytes: 0,
      segments: 0,
      durationSec: 0,
      outputFiles: [],
      savedPartCount: 0,
      lastError: "",
      lastSavedAt: "",
      savedVia: ""
    });
    await notifyBackground("RECORDER_NOTICE", {
      taskId: this.task.id,
      noticeType: "started",
      patch: {
        status: "recording",
        statusText: "正在录制，结束后自动转换 AVI",
        currentFileName: recordingState.activePart.targetFileName,
        quality: play.quality,
        qualityQn: play.qn
      }
    });

    let consecutiveOffline = 0;
    let lastRoomCheck = Date.now();
    let playlistFailures = 0;
    let stopReason = "stream_ended";
    let finalError = "";

    try {
      while (this.running && !shuttingDown) {
        if (Date.now() - lastRoomCheck >= 20000) {
          lastRoomCheck = Date.now();
          try {
            const status = await fetchLiveStatus(
              this.task.roomId,
              this.abortController.signal
            );
            this.task = { ...this.task, ...status };
            if (!status.liveStatus) {
              consecutiveOffline += 1;
            } else {
              consecutiveOffline = 0;
              if (Number(status.liveTime) > Number(recordingState.liveTime) + 30) {
                stopReason = "new_session";
                break;
              }
            }
            await this.patch({
              liveStatus: status.liveStatus,
              liveTime: status.liveTime,
              title: status.title,
              cover: status.cover,
              lastCheckedAt: nowIso()
            });
          } catch (error) {
            if (isAbortError(error)) throw error;
          }
        }

        if (consecutiveOffline >= 2) {
          stopReason = "stream_ended";
          break;
        }

        let playlist;
        try {
          const text = await fetchPlaylistText(play.url, this.abortController.signal);
          playlist = parseHlsPlaylist(text, play.url);
          if (playlist.kind === "master") {
            play.url = playlist.variants[0].url;
            playlist = parseHlsPlaylist(
              await fetchPlaylistText(play.url, this.abortController.signal),
              play.url
            );
          }
          playlistFailures = 0;
        } catch (error) {
          if (isAbortError(error)) throw error;
          playlistFailures += 1;
          if (isExpiredStreamError(error) || playlistFailures >= 4) {
            play = await this.refreshPlayUrl();
            if (!play.live) {
              stopReason = "stream_ended";
              break;
            }
          }
          await delay(Math.min(8000, 1000 * playlistFailures), this.abortController.signal);
          continue;
        }

        const newSegments = selectNewSegments(playlist, recordingState);
        if (newSegments.length) {
          updateSequenceGap(recordingState, newSegments[0].sequence);
        }

        for (const segment of newSegments) {
          if (!this.running || shuttingDown) {
            stopReason = this.stopReason || "stopped";
            break;
          }
          try {
            const segmentDuration = Number(segment.duration) || 0;
            const currentPart = recordingState.activePart;
            if (
              currentPart.sink.bytes > 0 &&
              shouldStartNewRecordingPart(
                currentPart.durationSec,
                segmentDuration
              )
            ) {
              await this.finishActivePart(recordingState);
              await this.beginPart(recordingState);
              await this.patch({
                currentFileName: recordingState.activePart.targetFileName,
                statusText: `正在录制第 ${recordingState.partNumber} 段`
              });
            }
            const data = await fetchSegment(segment.url, this.abortController.signal);
            const part = recordingState.activePart;
            if (segment.mapUrl && !part.writtenMapFiles.has(segment.mapUrl)) {
              const initData = await fetchSegment(
                segment.mapUrl,
                this.abortController.signal
              );
              await part.sink.write(initData);
              part.writtenMapFiles.add(segment.mapUrl);
            }
            await part.sink.write(data);
            recordingState.savedSegmentIds.add(segment.id);
            recordingState.bytes = recordingState.parts.reduce(
              (total, item) => total + item.sink.bytes,
              0
            );
            recordingState.segments += 1;
            recordingState.durationSec += segmentDuration;
            part.segments += 1;
            part.durationSec += segmentDuration;
            await this.patchStats(recordingState);
          } catch (error) {
            if (isAbortError(error)) throw error;
            if (isExpiredStreamError(error)) {
              play = await this.refreshPlayUrl();
              if (!play.live) {
                stopReason = "stream_ended";
                break;
              }
            }
            console.warn("Segment failed", segment.url, error);
            await delay(1000, this.abortController.signal);
          }
        }

        if (playlist.ended) {
          stopReason = "playlist_ended";
          break;
        }

        await delay(
          playlistPollInterval(playlist.targetDuration),
          this.abortController.signal
        );
      }
    } catch (error) {
      if (!isAbortError(error) && !shuttingDown && this.running) {
        finalError = normalizeError(error).message;
        stopReason = "error";
      } else if (isAbortError(error)) {
        stopReason = this.stopReason || "stopped";
      }
    } finally {
      await this.finishActivePart(recordingState).catch((error) => {
        finalError = finalError || `关闭录像文件失败：${normalizeError(error).message}`;
      });
    }

    await this.finishSession(recordingState, stopReason, finalError);
  }

  async refreshPlayUrl() {
    const play = await fetchPlayUrl(
      this.task.roomId,
      settings.requestedQn || 10000,
      this.abortController.signal
    );
    if (!play.live && this.running) {
      await this.patch({
        liveStatus: false,
        status: "waiting",
        statusText: "等待开播"
      });
    }
    return play;
  }

  async beginPart(recordingState) {
    recordingState.partNumber += 1;
    const partSuffix = recordingPartSuffix(recordingState.partNumber);
    const sourceFileName = `${recordingState.baseFileName}${partSuffix}.source`;
    const sink = await createRecordingSink({
      settings,
      fileName: sourceFileName
    });
    const desiredTargetName = `${recordingState.baseFileName}${partSuffix}.avi`;
    const targetFileName = await this.findAvailableTargetName(
      sink,
      desiredTargetName
    );
    const part = {
      number: recordingState.partNumber,
      sink,
      sourceFileName,
      targetFileName,
      writtenMapFiles: new Set(),
      segments: 0,
      durationSec: 0,
      progress: 0,
      lastProgressPatch: 0,
      converted: false
    };
    recordingState.activePart = part;
    recordingState.parts.push(part);
    return part;
  }

  async findAvailableTargetName(sink, desiredName) {
    const directory = sink.directoryHandle;
    if (!directory) return desiredName;

    const exists = async (name) => {
      try {
        await directory.getFileHandle(name, { create: false });
        return true;
      } catch (error) {
        if (error?.name === "NotFoundError") return false;
        throw error;
      }
    };

    if (!(await exists(desiredName))) return desiredName;
    const stem = desiredName.replace(/\.avi$/i, "");
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${stem} (${index}).avi`;
      if (!(await exists(candidate))) return candidate;
    }
    throw new Error("同名录像过多，无法生成唯一的 AVI 文件名");
  }

  async finishActivePart(recordingState) {
    const part = recordingState.activePart;
    if (!part) return;
    recordingState.activePart = null;
    try {
      await part.sink.close();
    } catch (error) {
      recordingState.conversionError =
        `关闭录制分片失败：${normalizeError(error).message}`;
      return;
    }

    if (part.sink.bytes <= 0 || part.segments <= 0) {
      await part.sink.discardFile();
      return;
    }
    this.schedulePartConversion(recordingState, part);
  }

  schedulePartConversion(recordingState, part) {
    recordingState.conversionChain = recordingState.conversionChain.then(
      async () => {
        const conversionStatus = () => ({
          status: recordingState.activePart ? "recording" : "finalizing",
          statusText: recordingState.activePart
            ? `正在录制，后台转换第 ${part.number} 段 AVI`
            : `正在转换第 ${part.number} 段为 AVI`
        });
        try {
          await this.patch({
            ...conversionStatus(),
            ...(recordingState.activePart
              ? {}
              : { currentFileName: part.targetFileName }),
            aviProgress: 0
          });
          const sourceData = await readRecordingSinkFile(part.sink);
          const aviData = await remuxToAvi(sourceData, {
            onProgress: (progress) => {
              const percent = Math.round(progress * 100);
              if (
                percent >= 100 ||
                percent - part.lastProgressPatch >= 10
              ) {
                part.lastProgressPatch = percent;
                part.progress = percent;
                this.patch({
                  status: recordingState.activePart ? "recording" : "finalizing",
                  statusText: recordingState.activePart
                    ? `正在录制，后台转换第 ${part.number} 段 AVI · ${percent}%`
                    : `正在转换第 ${part.number} 段为 AVI · ${percent}%`,
                  aviProgress: percent
                }).catch(() => {});
              }
            }
          });
          const output = await writeAviOutput(
            part.sink,
            part.targetFileName,
            aviData
          );

          let savedVia = output.mode === "folder" ? "folder" : "pending";
          let saveLocation = output.location;
          let saveError = "";
          if (output.mode === "temporary") {
            const downloadResult = await triggerTemporaryDownload(
              part.targetFileName
            );
            if (downloadResult.ok) {
              savedVia = "download";
              saveLocation = "浏览器下载目录";
              await deleteTemporaryFile(part.targetFileName).catch(() => {});
            } else {
              saveError =
                downloadResult.error ||
                "AVI 已生成，请在控制台手动保存暂存文件";
            }
          }

          await part.sink.discardFile();
          part.converted = true;
          recordingState.outputFiles.push({
            name: part.targetFileName,
            size: output.size,
            durationSec: Math.round(part.durationSec),
            savedVia,
            saveLocation,
            createdAt: nowIso()
          });
          recordingState.outputBytes += output.size;

          await this.patch({
            bytes:
              recordingState.outputBytes +
              (recordingState.activePart?.sink.bytes || 0),
            outputFiles: [...recordingState.outputFiles],
            savedPartCount: recordingState.outputFiles.length,
            lastSavedAt: savedVia === "pending" ? "" : nowIso(),
            savedVia,
            saveLocation,
            ...(recordingState.activePart
              ? {}
              : { currentFileName: part.targetFileName }),
            aviProgress: 100,
            lastError: saveError || recordingState.conversionError || ""
          });
        } catch (error) {
          const message = normalizeError(error).message;
          recordingState.conversionError =
            `第 ${part.number} 段 AVI 转换失败：${message}`;
          await this.patch({
            lastError: recordingState.conversionError,
            aviProgress: 0
          });
          console.warn("AVI conversion failed", part.sourceFileName, error);
        }
      }
    );
    return recordingState.conversionChain;
  }

  async finishSession(recordingState, stopReason, finalError) {
    const hadData = recordingState.segments > 0;
    await this.patch({
      status: hadData ? "finalizing" : "waiting",
      statusText: hadData ? "正在完成 AVI 文件" : "等待开播",
      bytes: recordingState.bytes,
      segments: recordingState.segments,
      durationSec: Math.round(recordingState.durationSec),
      liveStatus: stopReason !== "stream_ended" ? this.task.liveStatus : false,
      lastError: finalError || ""
    });

    if (!hadData) {
      await recordingState.conversionChain;
      if (finalError) {
        await notifyBackground("RECORDER_NOTICE", {
          taskId: this.task.id,
          noticeType: "error",
          error: finalError
        });
      }
      return;
    }

    await recordingState.conversionChain;
    const outputFiles = recordingState.outputFiles;
    const pendingCount = outputFiles.filter(
      (file) => file.savedVia === "pending"
    ).length;
    const lastOutput = outputFiles.at(-1);
    const aggregateError =
      recordingState.conversionError ||
      finalError ||
      (pendingCount ? "部分 AVI 已完成，请在控制台手动保存暂存文件" : "");

    if (outputFiles.length > 0) {
      const statusText = pendingCount
        ? `已生成 ${outputFiles.length} 个 AVI，${pendingCount} 个待手动保存`
        : `已保存 ${outputFiles.length} 个 AVI，继续等待开播`;
      await this.patch({
        status: "waiting",
        statusText,
        lastSavedAt: pendingCount ? "" : nowIso(),
        savedVia: pendingCount ? "pending" : lastOutput.savedVia,
        saveLocation: pendingCount ? "浏览器暂存区" : lastOutput.saveLocation,
        currentFileName: lastOutput.name,
        outputFiles,
        savedPartCount: outputFiles.length,
        bytes: recordingState.outputBytes,
        segments: recordingState.segments,
        durationSec: Math.round(recordingState.durationSec),
        aviProgress: 100,
        lastError: aggregateError
      });
      await notifyBackground("RECORDER_NOTICE", {
        taskId: this.task.id,
        noticeType: pendingCount ? "error" : "saved",
        fileName: lastOutput.name,
        error: aggregateError,
        patch: {
          status: "waiting",
          statusText,
          lastSavedAt: pendingCount ? "" : nowIso(),
          savedVia: pendingCount ? "pending" : lastOutput.savedVia,
          saveLocation: pendingCount ? "浏览器暂存区" : lastOutput.saveLocation,
          currentFileName: lastOutput.name,
          outputFiles,
          savedPartCount: outputFiles.length,
          bytes: recordingState.outputBytes,
          lastError: aggregateError
        }
      });
    } else {
      await this.patch({
        status: "error",
        statusText: "录像已结束，但 AVI 转换失败",
        lastSavedAt: "",
        savedVia: "",
        currentFileName: "",
        bytes: recordingState.bytes,
        segments: recordingState.segments,
        durationSec: Math.round(recordingState.durationSec),
        lastError:
          aggregateError ||
          "AVI 转换失败。请检查 Edge 是否支持 WebAssembly 后重试。"
      });
      await notifyBackground("RECORDER_NOTICE", {
        taskId: this.task.id,
        noticeType: "error",
        error:
          aggregateError ||
          "AVI 转换失败。请检查 Edge 是否支持 WebAssembly 后重试。"
      });
    }
  }

  async patchStats(recordingState) {
    const now = Date.now();
    if (now - recordingState.lastPatchAt < 3000) return;
    recordingState.lastPatchAt = now;
    await this.patch({
      bytes: recordingState.bytes,
      segments: recordingState.segments,
      durationSec: Math.round(recordingState.durationSec),
      status: "recording",
      statusText: `正在录制 · ${formatBytes(recordingState.bytes)}`
    });
  }

  async patch(patch) {
    this.task = { ...this.task, ...patch };
    await notifyBackground("RECORDER_PATCH", {
      taskId: this.task.id,
      patch
    });
  }
}

async function triggerTemporaryDownload(fileName) {
  // The offscreen document owns the OPFS file and can always create a Blob URL.
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(OPFS_FOLDER, { create: true });
    const handle = await directory.getFileHandle(fileName);
    const file = await handle.getFile();
    const blob = new Blob([file], { type: mimeTypeForName(fileName) });
    const url = URL.createObjectURL(blob);
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "START_BLOB_DOWNLOAD",
      url,
      fileName
    });
    if (response?.ok) {
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
      return { ok: true };
    }
  } catch (error) {
    console.warn("Service-worker blob download failed", error);
  }

  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(OPFS_FOLDER, { create: true });
    const handle = await directory.getFileHandle(fileName);
    const file = await handle.getFile();
    const blob = new Blob([file], { type: mimeTypeForName(fileName) });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `自动下载失败：${normalizeError(error).message}`
    };
  }
}

async function recoverOrphanedRecordings() {
  // Files are normally removed after a successful automatic download. Anything
  // left here is from a crash/manual-save fallback and is surfaced in the app.
  const files = await listTemporaryRecordings();
  if (files.length) {
    console.info(`Found ${files.length} temporary recording(s) awaiting save`);
  }
}

async function notifyBackground(type, payload) {
  try {
    await chrome.runtime.sendMessage({
      target: "background",
      type,
      ...payload
    });
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error?.message || "")) {
      console.warn("Could not notify background", type, error);
    }
  }
}

async function notify(type) {
  await notifyBackground(type, {});
}
