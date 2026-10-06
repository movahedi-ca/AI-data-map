# VENDOR-MANIFEST.md

Vendored third-party runtime assets for AI-data-map Phase 6 (client-side System-1 inference).
Generated: 2026-10-05. onnxruntime-web version: **1.20.1** (MIT license, Microsoft).

## Model files (`model/`)

| File | Source URL | Size (bytes) | SHA-256 | Requested by |
|---|---|---|---|---|
| `model.onnx` | https://huggingface.co/movahedi-ca/s1-workflow-tiny/resolve/main/model.onnx | 35378 | `cdec483f6b4525ddcd03900350a0cbec037a3fab4e1913a7d22804cdebc6a042` | Phase 6 web loader (first fetch; SHA-256 verified in-browser before first use, mismatch refuses to run) |
| `model.onnx.data` | https://huggingface.co/movahedi-ca/s1-workflow-tiny/resolve/main/model.onnx.data | 5570560 | `b425a53ad54ce5be3b1a29bcee41c2738cbc5478d4245ad7d93c88ca6bd64541` | `model.onnx` (external data reference) |

Both model hashes were verified EXACTLY against the pinned values before vendoring.

## onnxruntime-web 1.20.1 (`ort/`)

Source: npm package `onnxruntime-web@1.20.1` (`npm pack onnxruntime-web@1.20.1`), files taken from the package's `dist/` directory. `ort.min.js` is the web UMD bundle (the 1.20.x equivalent of the older `ort.web.min.js`).

| File | Source | Size (bytes) | SHA-256 | Requested by |
|---|---|---|---|---|
| `ort.min.js` | `onnxruntime-web@1.20.1` dist | 446284 | `be6e560b64c03c99252eedc0e1989e9e51e44d9f191e7655c9bf011bf9f576c8` | Page `<script>` tag (exposes `ort.InferenceSession.create`, `ort.Tensor`, `ort.env`) |
| `ort-wasm-simd-threaded.mjs` | `onnxruntime-web@1.20.1` dist | 24618 | `745eb7c0ce6f18a6aa521971b2877babc7ffb27eecb58ab3bc6e5ef4692672e8` | `ort.min.js` (wasm backend loader) |
| `ort-wasm-simd-threaded.wasm` | `onnxruntime-web@1.20.1` dist | 11246032 | `207d02be4591c156b0a98f024f3d58005b5b04c92274d759fb390338c63559ea` | `ort-wasm-simd-threaded.mjs` (`new URL("ort-wasm-simd-threaded.wasm", import.meta.url)`) |

## Sidecar completeness notes

- Sidecar discovery: grepped `ort.min.js` for every `*.mjs`/`*.wasm` filename it references (the only real hit is `ort-wasm-simd-threaded.mjs`; other matches were minified variable names such as `env.wasm`), and grepped `ort-wasm-simd-threaded.mjs` (only `ort-wasm-simd-threaded.wasm`). All referenced sidecars are vendored above.
- The inlined `ort-wasm-proxy-worker` string in `ort.min.js` is an inline worker-name constant; the proxy worker code ships inside the bundle (blob-generated), so no extra file is needed.
- 1.20.1's `dist/` ships **only** the SIMD-threaded wasm build (no single-threaded SIMD variant exists in this release), so the threaded build is used; correctness first per the task. Requires SharedArrayBuffer/COOP+COEP headers for the threaded wasm path.
- `ort.InferenceSession.create` verified present and loadable in Node with a minimal DOM stub (`self`/`window`); the threaded `.mjs` was also dynamically imported in Node and instantiates its wasm (`_OrtCreateSession` export confirmed).
- WebGPU: the base `ort.min.js` accepts `executionProviders: ['webgpu']` in its session-config API, but the actual WebGPU backend in 1.20.x lives in the `ort.webgpu.bundle.min.mjs` / `ort.all.min.js` distributions with the separate `ort-wasm-simd-threaded.jsep.*` sidecars, which are NOT vendored here. If Phase 6 needs GPU execution, add that bundle; the vendored set here covers the wasm (SIMD-threaded) provider fully.
