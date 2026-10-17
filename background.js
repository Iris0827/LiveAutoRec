import {
  makeTaskId,
  normalizeError,
  nowIso,
  parseRoomInput,
  sanitizeFilename
} from "./lib/common.js";
import {
  fetchRoomMeta,
  resolveShortUrl
} from "./lib/bilibili.js";

const DEFAULT_SETTINGS = {
  quality: "best",
  requestedQn: 20000,
  saveMode: "download",
  directoryName: "",
  notify: true
};

const WATCHDOG_ALARM = "bili-live-recorder-watchdog";
const APP_PAGE = "app.html";
let stateMutationQueue = Promise.resolve();
let offscreenCreating = null;
const lastErrorNotificationAt = new Map();

chrome.runtime.onInstalled.addListener(() => {
  initialize();
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) {
    wakeRecorder().catch((error) => console.warn("Recorder watchdog failed", error));
  }
});

chrome.action.onClicked.addListener(() => {
  openAppPage().catch((error) => console.warn("Could not open app page", error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get("appTabId").then(({ appTabId }) => {
    if (appTabId === tabId) {
      chrome.storage.local.remove("appTabId");
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return false;
  }
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.warn("Message failed", message?.type, error);
      sendResponse({
        ok: false,
        error: normalizeError(error).message
      });
    });
  return true;
});

initialize().catch((error) => console.warn("Initialization failed", error));

async function initialize() {
  const state = await getState();
  if (!state.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  await chrome.alarms.create(WATCHDOG_ALARM, {
    delayInMinutes: 0.5,
    periodInMinutes: 1
  });
  await wakeRecorder();
}

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_STATE":
      return { state: await getState() };
    case "ADD_TASK":
      return { state: await addTask(message.input), taskId: message.taskId };
    case "ADD_TASKS":
      return addTasks(message.inputs);
    case "REMOVE_TASK":
      return { state: await removeTask(message.taskId) };
    case "SET_TASK_ENABLED":
      return { state: await setTaskEnabled(message.taskId, Boolean(message.enabled)) };
    case "SET_SETTINGS":
      return { state: await updateSettings(message.settings || {}) };
    case "SYNC_RECORDER":
      await wakeRecorder();
      return { state: await getState() };
    case "REQUEST_SYNC":
      await wakeRecorder();
      return { state: await getState() };
    case "START_BLOB_DOWNLOAD":
      return downloadStagedFile(message.url, message.fileName);
    case "RECORDER_PATCH":
      return { state: await applyRecorderPatch(message.taskId, message.patch || {}) };
    case "RECORDER_NOTICE":
      await handleRecorderNotice(message);
      return {};
    case "GET_RECORDER_STATE":
      return { state: await getState() };
    case "OPEN_BILIBILI_LOGIN":
      await chrome.tabs.create({
        url: "https://passport.bilibili.com/login",
        active: true
      });
      return {};
    default:
      throw new Error("未知操作");
  }
}

async function getState() {
  const stored = await chrome.storage.local.get(["tasks", "settings"]);
  return {
    tasks: Array.isArray(stored.tasks) ? stored.tasks : [],
    settings: {
      ...DEFAULT_SETTINGS,
      ...(stored.settings || {})
    }
  };
}

async function mutateState(mutator) {
  const operation = stateMutationQueue.then(async () => {
    const state = await getState();
    await mutator(state);
    await chrome.storage.local.set({
      tasks: state.tasks,
      settings: state.settings
    });
    await updateBadge(state.tasks);
    return state;
  });
  stateMutationQueue = operation.catch(() => {});
  return operation;
}

async function addTask(rawInput) {
  let parsed = parseRoomInput(rawInput);
  if (parsed.kind === "shortUrl") {
    const resolvedUrl = await resolveShortUrl(parsed.url);
    parsed = parseRoomInput(resolvedUrl);
  }

  const meta = await fetchRoomMeta(parsed.roomId);
  const existing = (await getState()).tasks.find(
    (task) => Number(task.roomId) === Number(meta.roomId)
  );
  if (existing) {
    throw new Error("这个直播间已经在监控列表里");
  }

  const task = {
    id: makeTaskId(),
    input: parsed.input,
    roomId: meta.roomId,
    shortId: meta.shortId,
    uid: meta.uid,
    title: meta.title,
    uname: meta.uname,
    cover: meta.cover,
    face: meta.face,
    enabled: true,
    liveStatus: meta.liveStatus,
    liveTime: meta.liveTime,
    status: "waiting",
    statusText: meta.liveStatus ? "检测到开播，准备录制" : "等待开播",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastCheckedAt: nowIso(),
    bytes: 0,
    segments: 0,
    durationSec: 0,
    quality: "",
    currentFileName: "",
    lastError: ""
  };

  const state = await mutateState((draft) => {
    draft.tasks.push(task);
  });
  await wakeRecorder();
  return state;
}

async function addTasks(inputs) {
  const uniqueInputs = [...new Set(
    (Array.isArray(inputs) ? inputs : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
  if (!uniqueInputs.length) {
    throw new Error("请至少填写一个直播间地址");
  }
  if (uniqueInputs.length > 20) {
    throw new Error("一次最多添加 20 个直播间");
  }

  const added = [];
  const failed = [];
  let latestState = await getState();
  for (const input of uniqueInputs) {
    try {
      latestState = await addTask(input);
      added.push(input);
    } catch (error) {
      failed.push({
        input,
        error: normalizeError(error).message
      });
    }
  }
  return {
    state: latestState,
    added,
    failed
  };
}

async function removeTask(taskId) {
  await sendToOffscreen({
    type: "STOP_TASK",
    taskId,
    reason: "removed"
  });
  const state = await mutateState((draft) => {
    draft.tasks = draft.tasks.filter((task) => task.id !== taskId);
  });
  await refreshRecorderOrClose(state);
  return state;
}

async function setTaskEnabled(taskId, enabled) {
  const state = await mutateState((draft) => {
    const task = draft.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("没有找到这个监控任务");
    task.enabled = enabled;
    task.status = enabled ? "waiting" : "paused";
    task.statusText = enabled ? "等待开播" : "已暂停";
    task.updatedAt = nowIso();
    if (!enabled) {
      task.currentFileName = "";
    }
  });
  if (!enabled) {
    await sendToOffscreen({
      type: "STOP_TASK",
      taskId,
      reason: "paused"
    });
  }
  await refreshRecorderOrClose(state);
  return state;
}

async function updateSettings(settingsPatch) {
  const state = await mutateState((draft) => {
    draft.settings = {
      ...draft.settings,
      ...settingsPatch
    };
  });
  await refreshRecorderOrClose(state);
  return state;
}

async function applyRecorderPatch(taskId, patch) {
  return mutateState((draft) => {
    const task = draft.tasks.find((item) => item.id === taskId);
    if (!task) return;
    Object.assign(task, patch, {
      updatedAt: nowIso()
    });
  });
}

async function handleRecorderNotice(message) {
  if (message.noticeType === "saved") {
    lastErrorNotificationAt.delete(message.taskId);
    const state = await applyRecorderPatch(message.taskId, message.patch || {});
    const task = state.tasks.find((item) => item.id === message.taskId);
    if (task && state.settings.notify) {
      await showNotification(
        "直播录像已保存",
        `${task.uname || task.title || "直播间"}：${message.fileName || task.currentFileName || "录像文件"}`
      );
    }
  } else if (message.noticeType === "started") {
    lastErrorNotificationAt.delete(message.taskId);
    const state = await applyRecorderPatch(message.taskId, message.patch || {});
    const task = state.tasks.find((item) => item.id === message.taskId);
    if (task && state.settings.notify) {
      await showNotification("开始录制直播", task.title || task.uname || "B站直播");
    }
  } else if (message.noticeType === "error") {
    const state = await applyRecorderPatch(message.taskId, message.patch || {});
    const task = state.tasks.find((item) => item.id === message.taskId);
    const lastNoticeAt = lastErrorNotificationAt.get(message.taskId) || 0;
    if (task && state.settings.notify && Date.now() - lastNoticeAt > 10 * 60 * 1000) {
      lastErrorNotificationAt.set(message.taskId, Date.now());
      await showNotification("录制出现问题", message.error || task.lastError || "请在控制台查看");
    }
  }
}

async function showNotification(title, message) {
  try {
    await chrome.notifications.create(`bili-live-${Date.now()}-${Math.random().toString(16).slice(2)}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message: String(message).slice(0, 220)
    });
  } catch (error) {
    console.warn("Notification failed", error);
  }
}

async function downloadStagedFile(url, fileName) {
  if (!url || !fileName) {
    throw new Error("下载信息不完整");
  }
  const safeName = sanitizeFilename(fileName, "B站直播录像.avi", 180);
  const downloadId = await chrome.downloads.download({
    url,
    filename: `B站直播录像/${safeName}`,
    saveAs: false,
    conflictAction: "uniquify"
  });
  return { downloadId };
}

async function updateBadge(tasks) {
  const recording = (tasks || []).filter(
    (task) => task.enabled && ["recording", "finalizing"].includes(task.status)
  ).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#fb7299" });
  await chrome.action.setBadgeText({
    text: recording > 0 ? String(recording) : ""
  });
  await chrome.action.setTitle({
    title: recording > 0
      ? `正在录制 ${recording} 个直播间`
      : "打开 B站直播自动录制"
  });
}

async function wakeRecorder() {
  const state = await getState();
  if (!state.tasks.some((task) => task.enabled)) {
    await closeRecorder();
    return;
  }
  await ensureOffscreen();
  await sendToOffscreen({
    type: "SYNC_STATE",
    state
  });
}

async function refreshRecorderOrClose(state) {
  if (!state.tasks.some((task) => task.enabled)) {
    await closeRecorder();
    return;
  }
  await ensureOffscreen();
  await sendToOffscreen({
    type: "SYNC_STATE",
    state
  });
}

async function ensureOffscreen() {
  const hasDocument = await chrome.offscreen.hasDocument();
  if (hasDocument) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS", "WORKERS"],
        justification: "Continuously archive live HLS streams and stage blobs for download."
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

async function closeRecorder() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await sendToOffscreen({ type: "SHUTDOWN" });
      await chrome.offscreen.closeDocument();
    }
  } catch (error) {
    console.warn("Could not close recorder", error);
  }
}

async function sendToOffscreen(message) {
  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      ...message
    });
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error?.message || "")) {
      throw error;
    }
  }
}

async function openAppPage() {
  const { appTabId } = await chrome.storage.local.get("appTabId");
  if (appTabId) {
    try {
      await chrome.tabs.update(appTabId, { active: true });
      return;
    } catch {
      await chrome.storage.local.remove("appTabId");
    }
  }
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(APP_PAGE),
    active: true
  });
  if (tab.id) {
    await chrome.storage.local.set({ appTabId: tab.id });
  }
}
