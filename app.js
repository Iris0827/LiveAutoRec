import {
  formatBytes,
  formatDuration,
  normalizeError
} from "./lib/common.js";
import {
  deleteTemporaryFile,
  directoryPermission,
  getSavedDirectoryHandle,
  listTemporaryRecordings,
  saveDirectoryHandle,
  saveTemporaryFileAs
} from "./lib/file-store.js";

const QUALITY_TO_QN = {
  best: 20000,
  "1080p": 10000,
  "720p": 250,
  "480p": 150
};

const elements = {
  addForm: document.querySelector("#addForm"),
  roomUrl: document.querySelector("#roomUrl"),
  addButton: document.querySelector("#addButton"),
  taskList: document.querySelector("#taskList"),
  taskCount: document.querySelector("#taskCount"),
  pendingSection: document.querySelector("#pendingSection"),
  pendingList: document.querySelector("#pendingList"),
  pendingCount: document.querySelector("#pendingCount"),
  globalStatus: document.querySelector("#globalStatus"),
  globalStatusText: document.querySelector("#globalStatusText"),
  saveModeButtons: [...document.querySelectorAll("[data-save-mode]")],
  folderRow: document.querySelector("#folderRow"),
  folderName: document.querySelector("#folderName"),
  chooseFolderButton: document.querySelector("#chooseFolderButton"),
  qualitySelect: document.querySelector("#qualitySelect"),
  notifyToggle: document.querySelector("#notifyToggle"),
  loginButton: document.querySelector("#loginButton"),
  toast: document.querySelector("#toast")
};

let state = {
  tasks: [],
  settings: {
    quality: "best",
    requestedQn: 20000,
    saveMode: "download",
    directoryName: "",
    notify: true
  }
};
let toastTimer = null;
let refreshTimer = null;
let pendingLoading = false;

init().catch((error) => {
  showToast(normalizeError(error).message, "error");
  renderTasks();
});

async function init() {
  bindEvents();
  await refreshState();
  await refreshPendingFiles();
  chrome.storage.onChanged.addListener(handleStorageChange);
  refreshTimer = setInterval(() => {
    refreshPendingFiles().catch(() => {});
  }, 15000);
}

function bindEvents() {
  elements.addForm.addEventListener("submit", handleAddTask);
  elements.taskList.addEventListener("click", handleTaskAction);
  elements.pendingList.addEventListener("click", handlePendingAction);
  elements.saveModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setSaveMode(button.dataset.saveMode).catch((error) => {
        showToast(normalizeError(error).message, "error");
      });
    });
  });
  elements.chooseFolderButton.addEventListener("click", chooseOutputFolder);
  elements.qualitySelect.addEventListener("change", () => {
    const quality = elements.qualitySelect.value;
    saveSettings({
      quality,
      requestedQn: QUALITY_TO_QN[quality] || 10000
    });
  });
  elements.notifyToggle.addEventListener("change", () => {
    saveSettings({ notify: elements.notifyToggle.checked });
  });
  elements.loginButton.addEventListener("click", async () => {
    await sendMessage("OPEN_BILIBILI_LOGIN");
  });
}

async function refreshState() {
  const response = await sendMessage("GET_STATE");
  state = response.state;
  render();
}

function render() {
  renderTasks();
  renderSettings();
  renderGlobalStatus();
}

function renderGlobalStatus() {
  const recording = state.tasks.filter(
    (task) => task.enabled && ["recording", "finalizing"].includes(task.status)
  ).length;
  const enabled = state.tasks.filter((task) => task.enabled).length;
  elements.globalStatus.classList.toggle("live", recording > 0);
  elements.globalStatus.classList.toggle("ready", recording === 0 && enabled > 0);
  if (recording > 0) {
    elements.globalStatusText.textContent = `正在录制 ${recording} 个直播间`;
  } else if (enabled > 0) {
    elements.globalStatusText.textContent = `后台监控 ${enabled} 个直播间`;
  } else {
    elements.globalStatusText.textContent = "后台待命";
  }
}

function renderSettings() {
  const settings = state.settings;
  const mode = settings.saveMode === "folder" ? "folder" : "download";
  elements.saveModeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.saveMode === mode);
    button.setAttribute("aria-pressed", String(button.dataset.saveMode === mode));
  });
  elements.folderRow.hidden = mode !== "folder";
  elements.folderName.textContent = settings.directoryName || "尚未选择";
  if (document.activeElement !== elements.qualitySelect) {
    elements.qualitySelect.value = settings.quality || "best";
  }
  elements.notifyToggle.checked = settings.notify !== false;
}

function renderTasks() {
  const tasks = state.tasks || [];
  elements.taskCount.textContent = String(tasks.length);

  if (!tasks.length) {
    elements.taskList.innerHTML = `
      <div class="empty-state">
        <span class="empty-mark">＋</span>
        <strong>还没有添加直播间</strong>
        <span>把上方地址栏里的 URL 粘进来就行</span>
      </div>
    `;
    return;
  }

  elements.taskList.innerHTML = tasks.map(renderTaskCard).join("");
}

function renderTaskCard(task) {
  const status = task.enabled ? (task.status || "waiting") : "paused";
  const statusText = task.enabled
    ? task.statusText || statusLabel(status)
    : "已暂停";
  const stats = [];
  if (task.durationSec > 0) stats.push(`时长 ${formatDuration(task.durationSec)}`);
  if (task.bytes > 0) stats.push(formatBytes(task.bytes));
  if (task.segments > 0) stats.push(`${task.segments} 个分片`);
  if (task.quality) stats.push(task.quality);
  if (task.liveStatus) stats.push("直播中");

  const cover = task.cover
    ? `<img class="task-cover" src="${escapeAttribute(task.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="task-cover task-cover-fallback">${escapeHtml((task.uname || task.title || "B").slice(0, 1))}</div>`;

  const outputFiles = Array.isArray(task.outputFiles) ? task.outputFiles : [];
  const lastOutput = outputFiles.at(-1);
  const saved = lastOutput
    ? `<div class="task-last-save">${lastOutput.savedVia === "pending" ? "AVI 已生成，等待手动保存" : `已保存 ${outputFiles.length} 个 AVI · ${escapeHtml(lastOutput.saveLocation || "保存目录")}`} · ${escapeHtml(lastOutput.name)}</div>`
    : task.lastSavedAt
      ? `<div class="task-last-save">已保存 · ${escapeHtml(task.saveLocation || "浏览器下载目录")}${task.currentFileName ? ` · ${escapeHtml(task.currentFileName)}` : ""}</div>`
      : "";
  const error = task.lastError
    ? `<div class="task-error">${escapeHtml(task.lastError)}</div>`
    : "";
  const liveLink = task.roomId
    ? `<a class="task-anchor" href="https://live.bilibili.com/${encodeURIComponent(task.roomId)}" target="_blank" rel="noreferrer">${escapeHtml(task.uname || `房间 ${task.roomId}`)}</a>`
    : "";

  return `
    <article class="task-card ${status}" data-task-id="${escapeAttribute(task.id)}">
      ${cover}
      <div class="task-body">
        <div class="task-title-row">
          <h3 class="task-title" title="${escapeAttribute(task.title || "")}">${escapeHtml(task.title || "B站直播")}</h3>
          <span class="status-badge ${status}">${escapeHtml(statusText)}</span>
        </div>
        ${liveLink}
        ${stats.length ? `<div class="task-meta">${stats.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
        ${saved}
        ${error}
      </div>
      <div class="task-actions">
        <button
          class="icon-button"
          type="button"
          data-action="toggle"
          data-task-id="${escapeAttribute(task.id)}"
          title="${task.enabled ? "暂停监控并结束本次录制" : "继续监控"}"
          aria-label="${task.enabled ? "暂停监控" : "继续监控"}"
        >${task.enabled ? pauseIcon() : playIcon()}</button>
        <button
          class="icon-button danger"
          type="button"
          data-action="remove"
          data-task-id="${escapeAttribute(task.id)}"
          title="删除监控"
          aria-label="删除监控"
        >${trashIcon()}</button>
      </div>
    </article>
  `;
}

function statusLabel(status) {
  return {
    waiting: "等待开播",
    recording: "正在录制",
    finalizing: "正在收尾",
    paused: "已暂停",
    error: "连接错误"
  }[status] || "等待中";
}

async function handleAddTask(event) {
  event.preventDefault();
  const inputs = elements.roomUrl.value
    .split(/[\r\n\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!inputs.length) {
    elements.roomUrl.focus();
    showToast("先粘贴至少一个直播间地址", "error");
    return;
  }
  if (inputs.length > 20) {
    showToast("一次最多添加 20 个直播间", "error");
    return;
  }

  setAddBusy(true);
  try {
    const response = await sendMessage("ADD_TASKS", { inputs });
    state = response.state;
    render();
    elements.roomUrl.value = "";
    const addedCount = response.added?.length || 0;
    const failed = response.failed || [];
    if (addedCount) {
      showToast(
        `已添加 ${addedCount} 个直播间${failed.length ? `，${failed.length} 个未添加` : ""}，开播后自动录制`,
        "success"
      );
    } else {
      showToast(
        failed[0] ? `${failed[0].input}：${failed[0].error}` : "没有添加直播间",
        "error"
      );
    }
  } catch (error) {
    showToast(normalizeError(error).message, "error");
  } finally {
    setAddBusy(false);
  }
}

function setAddBusy(busy) {
  elements.addButton.disabled = busy;
  elements.addButton.querySelector("span").textContent = busy ? "正在添加…" : "批量添加";
}

async function handleTaskAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const task = state.tasks.find((item) => item.id === button.dataset.taskId);
  if (!task) return;

  if (button.dataset.action === "toggle") {
    button.disabled = true;
    try {
      const response = await sendMessage("SET_TASK_ENABLED", {
        taskId: task.id,
        enabled: !task.enabled
      });
      state = response.state;
      render();
      showToast(
        task.enabled
          ? "已暂停监控；正在结束本次录像"
          : "已恢复监控，开播后会自动录制",
        "success"
      );
    } catch (error) {
      showToast(normalizeError(error).message, "error");
    } finally {
      button.disabled = false;
    }
    return;
  }

  if (button.dataset.action === "remove") {
    const recording = task.status === "recording" || task.status === "finalizing";
    const prompt = recording
      ? "这个直播间正在录制。删除监控会结束并保存当前录像，确定继续吗？"
      : "确定移除这个直播间的监控吗？";
    if (!window.confirm(prompt)) return;
    button.disabled = true;
    try {
      const response = await sendMessage("REMOVE_TASK", { taskId: task.id });
      state = response.state;
      render();
      showToast(recording ? "监控已移除，正在保存已录制内容" : "监控已移除", "success");
      setTimeout(() => refreshPendingFiles().catch(() => {}), 1800);
    } catch (error) {
      showToast(normalizeError(error).message, "error");
    } finally {
      button.disabled = false;
    }
  }
}

async function setSaveMode(mode) {
  if (mode === "folder") {
    await chooseOutputFolder();
  } else {
    await saveSettings({ saveMode: "download" });
    showToast("录像结束后会自动下载", "success");
  }
}

async function chooseOutputFolder() {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("当前 Edge 版本不支持选择文件夹，请升级浏览器或改用自动下载");
  }

  let handle = await getSavedDirectoryHandle();
  if (handle) {
    const permission = await directoryPermission(handle, true);
    if (permission !== "granted") {
      handle = null;
    }
  }
  if (!handle) {
    handle = await window.showDirectoryPicker({
      id: "bili-live-output",
      mode: "readwrite",
      startIn: "downloads"
    });
    await saveDirectoryHandle(handle);
  }

  const response = await sendMessage("SET_SETTINGS", {
    settings: {
      saveMode: "folder",
      directoryName: handle.name
    }
  });
  state = response.state;
  render();
  showToast(`录像将直接写入「${handle.name}」`, "success");
}

async function saveSettings(patch) {
  const response = await sendMessage("SET_SETTINGS", { settings: patch });
  state = response.state;
  render();
}

async function refreshPendingFiles() {
  if (pendingLoading) return;
  pendingLoading = true;
  try {
    const files = await listTemporaryRecordings();
    renderPendingFiles(files);
  } catch (error) {
    console.warn("Could not list temporary recordings", error);
  } finally {
    pendingLoading = false;
  }
}

function renderPendingFiles(files) {
  elements.pendingSection.hidden = files.length === 0;
  elements.pendingCount.textContent = String(files.length);
  if (!files.length) {
    elements.pendingList.innerHTML = "";
    return;
  }
  elements.pendingList.innerHTML = files.map((file) => `
    <div class="pending-file">
      <div class="pending-file-name">
        <strong title="${escapeAttribute(file.name)}">${escapeHtml(file.name)}</strong>
        <span>${escapeHtml(formatBytes(file.size))} · ${escapeHtml(new Date(file.lastModified).toLocaleString("zh-CN"))}</span>
      </div>
      <div class="pending-actions">
        <button class="icon-button" type="button" data-action="save-file" data-file-name="${escapeAttribute(file.name)}" title="保存到电脑" aria-label="保存到电脑">${downloadIcon()}</button>
        <button class="icon-button danger" type="button" data-action="delete-file" data-file-name="${escapeAttribute(file.name)}" title="删除暂存文件" aria-label="删除暂存文件">${trashIcon()}</button>
      </div>
    </div>
  `).join("");
}

async function handlePendingAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const fileName = button.dataset.fileName;
  button.disabled = true;
  try {
    if (button.dataset.action === "save-file") {
      showToast("请选择录像保存位置", "success");
      const result = await saveTemporaryFileAs(fileName);
      if (result.method === "picker") {
        await deleteTemporaryFile(fileName);
        showToast("录像已保存", "success");
      } else {
        showToast("已开始下载；完成后可删除暂存文件", "success");
        setTimeout(() => refreshPendingFiles().catch(() => {}), 3000);
      }
      await refreshPendingFiles();
    } else if (button.dataset.action === "delete-file") {
      if (!window.confirm(`确定删除浏览器暂存的「${fileName}」吗？此操作无法恢复。`)) {
        button.disabled = false;
        return;
      }
      await deleteTemporaryFile(fileName);
      await refreshPendingFiles();
      showToast("暂存文件已删除", "success");
    }
  } catch (error) {
    if (error?.name !== "AbortError") {
      showToast(normalizeError(error).message, "error");
    }
  } finally {
    button.disabled = false;
  }
}

function handleStorageChange(changes, areaName) {
  if (areaName !== "local" || (!changes.tasks && !changes.settings)) return;
  refreshState()
    .catch((error) => console.warn("State refresh failed", error));
}

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type,
    ...payload
  });
  if (!response?.ok) {
    throw new Error(response?.error || "扩展后台没有响应");
  }
  return response;
}

function showToast(message, tone = "") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast ${tone}`.trim();
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, tone === "error" ? 6500 : 3800);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function pauseIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function playIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5V7Z" fill="currentColor"/></svg>`;
}

function trashIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2m-8 0 1 12h8l1-12M10 11v5m4-5v5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function downloadIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

window.addEventListener("beforeunload", () => {
  clearInterval(refreshTimer);
});
