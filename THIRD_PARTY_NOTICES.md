# Third-party notices

This extension bundles the following open-source components:

## ffmpeg.wasm

- `@ffmpeg/ffmpeg` 0.12.15
- `@ffmpeg/core` 0.12.10 (single-thread)
- Project: https://github.com/ffmpegwasm/ffmpeg.wasm
- Wrapper license: MIT
- WASM core license: GPL-2.0-or-later

The bundled FFmpeg WebAssembly core is used locally to remux recorded MPEG-TS
data into AVI containers. It does not make network requests or upload media.

Source archives:

- https://registry.npmjs.org/@ffmpeg/ffmpeg/-/ffmpeg-0.12.15.tgz
- https://registry.npmjs.org/@ffmpeg/core/-/core-0.12.10.tgz
