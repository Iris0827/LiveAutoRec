const DB_NAME = "bili-live-recorder";
const DB_VERSION = 1;
const HANDLE_STORE = "settings";
const DIRECTORY_KEY = "outputDirectory";
export const OPFS_FOLDER = "bili-live-recordings";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(HANDLE_STORE)) {
        database.createObjectStore(HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地设置数据库"));
  });
}

async function withStore(mode, callback) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE, mode);
      const store = transaction.objectStore(HANDLE_STORE);
      let request;
      try {
        request = callback(store);
      } catch (error) {
        reject(error);
        return;
      }
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("保存目录操作失败"));
    });
  } finally {
    database.close();
  }
}

export async function saveDirectoryHandle(handle) {
  await withStore("readwrite", (store) => store.put(handle, DIRECTORY_KEY));
}

export async function getSavedDirectoryHandle() {
  return withStore("readonly", (store) => store.get(DIRECTORY_KEY));
}

export async function clearSavedDirectoryHandle() {
  await withStore("readwrite", (store) => store.delete(DIRECTORY_KEY));
}

export async function directoryPermission(handle, request = false) {
  if (!handle) return "missing";
  const options = { mode: "readwrite" };
  let state = await handle.queryPermission(options);
  if (state === "prompt" && request) {
    state = await handle.requestPermission(options);
  }
  return state;
}

export class RecordingSink {
  constructor({
    writer,
    bytes = 0,
    mode,
    pathLabel,
    fileName,
    fileHandle = null,
    directoryHandle = null,
    temporaryHandle = null,
    temporaryDirectory = null
  }) {
    this.writer = writer;
    this.bytes = bytes;
    this.mode = mode;
    this.pathLabel = pathLabel;
    this.fileName = fileName;
    this.fileHandle = fileHandle;
    this.directoryHandle = directoryHandle;
    this.temporaryHandle = temporaryHandle;
    this.temporaryDirectory = temporaryDirectory;
    this.closed = false;
  }

  async write(data) {
    if (this.closed) throw new Error("录制文件已经关闭");
    await this.writer.write(data);
    this.bytes += data.byteLength;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.writer.close();
  }

  async discardTemporaryFile() {
    if (this.mode !== "temporary" || !this.temporaryDirectory) return;
    try {
      await this.temporaryDirectory.removeEntry(this.fileName);
    } catch {
      // The browser may already have released or moved the temporary entry.
    }
  }

  async discardFile() {
    if (this.mode === "temporary") {
      await this.discardTemporaryFile();
      return;
    }
    if (!this.directoryHandle) return;
    try {
      await this.directoryHandle.removeEntry(this.fileName);
    } catch {
      // The file may already have been removed by the user.
    }
  }
}

export async function createRecordingSink({ settings, fileName }) {
  if (settings.saveMode === "folder") {
    const directoryHandle = await getSavedDirectoryHandle();
    if (directoryHandle) {
      const permission = await directoryPermission(directoryHandle, false);
      if (permission === "granted") {
        const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
        const writer = await fileHandle.createWritable({ keepExistingData: false });
        return new RecordingSink({
          writer,
          mode: "folder",
          pathLabel: directoryHandle.name,
          fileName,
          fileHandle,
          directoryHandle
        });
      }
    }
  }

  const root = await navigator.storage.getDirectory();
  const temporaryDirectory = await root.getDirectoryHandle(OPFS_FOLDER, { create: true });
  const temporaryHandle = await temporaryDirectory.getFileHandle(fileName, { create: true });
  const writer = await temporaryHandle.createWritable({ keepExistingData: false });
  return new RecordingSink({
    writer,
    mode: "temporary",
    pathLabel: "浏览器暂存区",
    fileName,
    fileHandle: temporaryHandle,
    directoryHandle: temporaryDirectory,
    temporaryHandle,
    temporaryDirectory
  });
}

export async function readRecordingSinkFile(sink) {
  if (!sink.fileHandle) {
    throw new Error("找不到待转换的录像文件");
  }
  const file = await sink.fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function writeAviOutput(sink, fileName, data) {
  if (sink.mode === "folder") {
    if (!sink.directoryHandle) {
      throw new Error("保存文件夹不可用");
    }
    const fileHandle = await sink.directoryHandle.getFileHandle(fileName, {
      create: true
    });
    const writer = await fileHandle.createWritable({ keepExistingData: false });
    try {
      await writer.write(data);
    } finally {
      await writer.close();
    }
    return {
      mode: "folder",
      fileName,
      size: data.byteLength,
      location: sink.pathLabel
    };
  }

  if (!sink.temporaryDirectory) {
    throw new Error("浏览器暂存目录不可用");
  }
  const fileHandle = await sink.temporaryDirectory.getFileHandle(fileName, {
    create: true
  });
  const writer = await fileHandle.createWritable({ keepExistingData: false });
  try {
    await writer.write(data);
  } finally {
    await writer.close();
  }
  return {
    mode: "temporary",
    fileName,
    size: data.byteLength,
    location: "浏览器暂存区"
  };
}

export async function listTemporaryRecordings() {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(OPFS_FOLDER, { create: true });
  const files = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== "file") continue;
    if (!/\.avi$/i.test(name)) continue;
    const file = await handle.getFile();
    if (file.size <= 0) continue;
    files.push({
      name,
      size: file.size,
      lastModified: file.lastModified
    });
  }
  files.sort((left, right) => right.lastModified - left.lastModified);
  return files;
}

export async function getTemporaryFile(name) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(OPFS_FOLDER, { create: true });
  const handle = await directory.getFileHandle(name);
  return handle.getFile();
}

export async function deleteTemporaryFile(name) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(OPFS_FOLDER, { create: true });
  await directory.removeEntry(name);
}

export async function saveTemporaryFileAs(name) {
  const file = await getTemporaryFile(name);
  if (!("showSaveFilePicker" in window)) {
    const blob = new Blob([file], { type: mimeTypeForName(name) });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    return { fileName: name, method: "download" };
  }

  const target = await window.showSaveFilePicker({
    suggestedName: name
  });
  const writable = await target.createWritable();
  await file.stream().pipeTo(writable);
  return { fileName: target.name || name, method: "picker" };
}

export function mimeTypeForName(name) {
  if (/\.avi$/i.test(name)) return "video/x-msvideo";
  if (/\.mp4$/i.test(name)) return "video/mp4";
  return "video/mp2t";
}
