import { writeFile } from "node:fs/promises";
import process from "node:process";

const debugPort = process.env.EDGE_DEBUG_PORT || "9333";
const baseUrl = `http://127.0.0.1:${debugPort}`;

class CdpConnection {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = new WebSocket(webSocketUrl);
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket timeout")), 10000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket error: ${event.message || "unknown"}`));
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function main() {
  const version = await getJson(`${baseUrl}/json/version`);
  const browser = new CdpConnection(version.webSocketDebuggerUrl);
  await browser.open();

  const targets = await getJson(`${baseUrl}/json/list`);
  const background = targets.find(
    (target) => target.type === "service_worker" && /\/background\.js$/.test(target.url)
  );
  if (!background) {
    throw new Error("Extension service worker is not loaded");
  }
  const extensionId = new URL(background.url).hostname;
  console.log(`Extension loaded: ${extensionId}`);

  const backgroundConnection = new CdpConnection(background.webSocketDebuggerUrl);
  await backgroundConnection.open();
  await backgroundConnection.send("Runtime.enable");
  await sleep(1200);
  const serviceState = await evaluate(
    backgroundConnection,
    "chrome.storage.local.get(null)"
  );
  console.log("Initial storage:", JSON.stringify(serviceState));

  const appUrl = `chrome-extension://${extensionId}/app.html`;
  await browser.send("Target.createTarget", { url: appUrl });
  await sleep(1200);
  const pageTargets = await getJson(`${baseUrl}/json/list`);
  const appTarget = pageTargets.find((target) => target.url === appUrl);
  if (!appTarget) {
    throw new Error("App page target was not created");
  }

  const page = new CdpConnection(appTarget.webSocketDebuggerUrl);
  await page.open();
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Log.enable");
  await sleep(1000);

  const initialPage = await evaluate(page, `({
    title: document.title,
    h1: document.querySelector("h1")?.innerText,
    taskText: document.querySelector("#taskList")?.innerText,
    hasAddForm: Boolean(document.querySelector("#addForm")),
    inputTag: document.querySelector("#roomUrl")?.tagName,
    bodySize: document.body.getBoundingClientRect().toJSON()
  })`);
  console.log("Page:", JSON.stringify(initialPage));

  await evaluate(page, `(async () => {
    const stored = await chrome.storage.local.get("tasks");
    for (const task of stored.tasks || []) {
      await chrome.runtime.sendMessage({
        target: "background",
        type: "REMOVE_TASK",
        taskId: task.id
      });
    }
    return true;
  })()`);
  await sleep(800);

  await evaluate(page, `(() => {
    const input = document.querySelector("#roomUrl");
    input.value = "https://live.bilibili.com/6\\nhttps://live.bilibili.com/3";
    document.querySelector("#addForm").requestSubmit();
    return true;
  })()`);

  let recording = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(1000);
    const state = await evaluate(page, "chrome.storage.local.get(['tasks', 'settings'])");
    const task = state.tasks?.find((item) => Number(item.roomId) === 7734200);
    recording = {
      taskCount: state.tasks?.length || 0,
      status: task?.status,
      statusText: task?.statusText,
      bytes: task?.bytes,
      segments: task?.segments,
      quality: task?.quality,
      fileName: task?.currentFileName,
      error: task?.lastError
    };
    if (task?.status === "recording" && Number(task.bytes) > 0) break;
  }
  console.log("Recording state:", JSON.stringify(recording));
  if (recording.taskCount !== 2) {
    throw new Error("Batch add did not create two room tasks");
  }
  if (!/^\[[^\]]+\].+\[\d{4}-\d{2}-\d{2}\]\.avi$/.test(recording.fileName || "")) {
    throw new Error("Recording filename does not match [主播名称]直播名称[直播日期].avi");
  }
  if (recording.status !== "recording" || !(recording.bytes > 0)) {
    throw new Error("The live room did not start recording");
  }

  const screenshot = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true
  });
  await writeFile(".tmp-edge-app.png", Buffer.from(screenshot.data, "base64"));

  const opfs = await evaluate(page, `(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("bili-live-recordings", { create: true });
    const entries = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file") {
        const file = await handle.getFile();
        entries.push({ name, size: file.size });
      }
    }
    return entries;
  })()`);
  console.log("OPFS files:", JSON.stringify(opfs));

  await evaluate(page, `(async () => {
    const stored = await chrome.storage.local.get("tasks");
    const liveTask = stored.tasks.find((task) => Number(task.roomId) === 7734200);
    return chrome.runtime.sendMessage({
      target: "background",
      type: "SET_TASK_ENABLED",
      taskId: liveTask.id,
      enabled: false
    });
  })()`);

  await sleep(8000);
  const finalState = await evaluate(page, "chrome.storage.local.get(['tasks'])");
  const finalLiveTask = finalState.tasks?.find(
    (task) => Number(task.roomId) === 7734200
  );
  console.log("Final state:", JSON.stringify(finalLiveTask || {}));
  if (!finalLiveTask?.outputFiles?.length) {
    throw new Error("AVI output was not recorded in task state");
  }
  if (!finalLiveTask.outputFiles.at(-1).name.endsWith(".avi")) {
    throw new Error("Final output filename is not .avi");
  }

  const finalOpfs = await evaluate(page, `(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("bili-live-recordings", { create: true });
    const entries = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file") {
        const file = await handle.getFile();
        entries.push({ name, size: file.size });
      }
    }
    return entries;
  })()`);
  console.log("Final OPFS files:", JSON.stringify(finalOpfs));

  await backgroundConnection.send("Runtime.enable");
  const downloads = await evaluate(
    backgroundConnection,
    "chrome.downloads.search({ limit: 10, orderBy: ['-startTime'] })"
  );
  console.log("Downloads:", JSON.stringify(downloads));
  if (!downloads.some((item) => item.filename.endsWith(".avi") && item.state === "complete")) {
    throw new Error("AVI download did not complete");
  }

  const pageErrors = page.events.filter(
    (event) => event.method === "Runtime.exceptionThrown" || event.method === "Log.entryAdded"
  );
  if (pageErrors.length) {
    console.log("Page errors:", JSON.stringify(pageErrors));
  }

  page.close();
  backgroundConnection.close();
  browser.close();
}

async function evaluate(connection, expression) {
  const result = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      "Evaluation failed"
    );
  }
  return result.result?.value;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
