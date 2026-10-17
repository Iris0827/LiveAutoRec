import { FFmpeg } from "../vendor/ffmpeg/index.js";

let ffmpegInstance = null;
let loadPromise = null;
let operationQueue = Promise.resolve();
let fileCounter = 0;

export async function ensureAviConverter() {
  if (!loadPromise) {
    loadPromise = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: chrome.runtime.getURL("vendor/ffmpeg/ffmpeg-core.js"),
        wasmURL: chrome.runtime.getURL("vendor/ffmpeg/ffmpeg-core.wasm")
      });
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })().catch((error) => {
      loadPromise = null;
      throw new Error(`AVI 转换组件加载失败：${error?.message || error}`);
    });
  }
  return loadPromise;
}

export async function remuxToAvi(sourceData, { onProgress } = {}) {
  const operation = operationQueue.then(async () => {
    const ffmpeg = await ensureAviConverter();
    const id = ++fileCounter;
    const inputName = `live-source-${id}.ts`;
    const outputName = `live-output-${id}.avi`;
    const progressHandler = ({ progress }) => {
      if (Number.isFinite(progress)) {
        onProgress?.(Math.max(0, Math.min(1, progress)));
      }
    };

    ffmpeg.on("progress", progressHandler);
    try {
      await ffmpeg.writeFile(inputName, sourceData);
      const exitCode = await ffmpeg.exec([
        "-i", inputName,
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c", "copy",
        "-f", "avi",
        "-max_muxing_queue_size", "2048",
        outputName
      ]);
      if (exitCode !== 0) {
        throw new Error(`AVI 转换器返回错误码 ${exitCode}`);
      }

      const output = await ffmpeg.readFile(outputName);
      if (!(output instanceof Uint8Array) || output.byteLength === 0) {
        throw new Error("AVI 转换没有生成有效文件");
      }
      if (
        output[0] !== 0x52 ||
        output[1] !== 0x49 ||
        output[2] !== 0x46 ||
        output[3] !== 0x46
      ) {
        throw new Error("生成的 AVI 文件头无效");
      }
      return new Uint8Array(output);
    } finally {
      ffmpeg.off("progress", progressHandler);
      await ffmpeg.deleteFile(inputName).catch(() => {});
      await ffmpeg.deleteFile(outputName).catch(() => {});
    }
  });

  operationQueue = operation.catch(() => {});
  return operation;
}
