# DEPLOY-NOTE.md - Phase 7 movahedi.ca integration pack

How the System-1 data-mapping assistant ships on the movahedi.ca guide page.
Read this whole file before touching anything. Nothing here deploys itself.

## 0. Status gate: disclaimer is DRAFT PENDING COUNSEL REVIEW

The disclaimer copy added by `patches/0001-chatbot-panel.patch` is
`web/legal/DISCLAIMER-DRAFT.md` section 2, verbatim. Its sign-off block is
empty. **Do not launch the page with the assistant visible until counsel
completes that sign-off** (deploy checklist box 7 in
`web/legal/DEPLOY-CHECKLIST.md`). If counsel edits the copy, re-apply the
patch flow below with the revised wording and re-pin the page hashes.

## 1. What goes where

All paths below are relative to the Tier B tree root
(`~/workspace/data-mapping-interactive`), which builds Tier A via
`build_astro.py` and deploys via `deploy_site.py` (see Tier B
`INTEGRATION.md`; never raw `wrangler deploy`).

| # | Source (this repo) | Destination (Tier B / site) |
|---|---|---|
| 1 | `web/site-integration/bundle/` (whole tree, 20 files) | `demo/s1/` — copy preserving the internal layout (`executor/js/`, `executor/css/`, `executor/vendor/ort/`, `executor/vendor/model/`, `chatbot/js/`, `chatbot/css/`). `executor.js` resolves `vendor/model/model.onnx` and `vendor/ort/` relative to its own directory, so the layout must stay exactly as shipped. |
| 2 | `web/site-integration/patches/0001-chatbot-panel.patch` | Applied to `demo/index.html` + `demo/fr.html` with `patch -p1` from the Tier B root. |
| 3 | `web/site-integration/patches/0002-executor-wiring.patch` | Applied after 0001, same way. |
| 4 | `web/site-integration/csp-hashes.txt` (14 script hashes + inline-script note) | Pasted into the Worker's hash-based `script-src` policy at deploy. |

Verify the copy with `sha256sum -c`: run it inside the deployed `s1/`
directory against `web/site-integration/SHA256SUMS` after rewriting the
`bundle/` prefix (or compare each file's hash to the pinned values in
section 4 below). All 20 must match before the page goes live.

## 2. Patch application order (with dry-run)

From the Tier B root, in this order:

```
# Phase 1 first (the import UI this assistant sits next to)
patch --dry-run -p1 < <ai-data-map>/web/import/patches/0001-import-ui.patch
patch --dry-run -p1 < <ai-data-map>/web/import/patches/0002-builder-import-hook.patch
patch --dry-run -p1 < <ai-data-map>/web/import/patches/0003-exporter-row-order.patch
# then Phase 7
patch --dry-run -p1 < <ai-data-map>/web/site-integration/patches/0001-chatbot-panel.patch
patch --dry-run -p1 < <ai-data-map>/web/site-integration/patches/0002-executor-wiring.patch
```

Each dry-run must report clean application on `demo/index.html` and
`demo/fr.html` before the real apply. The Phase 7 patches touch different
page regions than the Phase 1 patches (head links, the new assistant block
after `#builder-print-sheet`, script includes at end of body), so they
compose; `patch` absorbing small offsets is normal, failed hunks are not.
If any hunk fails, stop and reconcile by hand, do not force.

Note: `0003-import-hook-reuse.patch` was deliberately not produced. The
Phase 1 `window.DMImport.applyState` hook is the spreadsheet-import path;
the assistant (chatbot to executor to review/export) never calls it, so no
hook change is needed. If a future phase wires the two flows together, that
phase authors the 0003 patch.

## 3. CSP hash installation

1. Paste the 14 `sha256-<base64>` values from `csp-hashes.txt` into the
   Worker's `script-src` for the guide page. They are computed from the
   exact bundle bytes; recompute if any bundled file changes.
2. Recompute the two inline-script hashes from the FINAL built page bytes
   (Tier A output of `build_astro.py`, not the Tier B source):
   the pre-existing `window.T` strings block, and the S1 init block added by
   patch 0002 (Tier B reference hash:
   `sha256-DJ1dShm65lGOA4TYnVd2qNIA3kyJ34TtiInxFeL11GA=`).
   Add both to `script-src`. No `unsafe-inline`, no `unsafe-eval`.
3. Confirm the Worker still serves the hash-based enforced CSP on the page
   (spot-check a response header on the preview URL).

## 4. Pinned hashes to verify at deploy

The browser refuses to run the model on a hash mismatch
(`executor.js` compares against `MODEL_SHA256`), but verify at deploy
anyway; a mismatch here means the bundle copy is corrupt or stale.

- `s1/executor/vendor/model/model.onnx`:
  `f5f15612c294b37955d416aafdfccd127361ee2bddc509d3c6ea3eefdbe1de62`
- `s1/executor/vendor/model/model.onnx.data`:
  `a2cdac628fedd2c98c2c304493a78ea2637fe8d20eb3149e271807a1e479ecad`
- `s1/executor/vendor/ort/ort.min.js`:
  `be6e560b64c03c99252eedc0e1989e9e51e44d9f191e7655c9bf011bf9f576c8`
- `s1/executor/vendor/ort/ort-wasm-simd-threaded.mjs`:
  `745eb7c0ce6f18a6aa521971b2877babc7ffb27eecb58ab3bc6e5ef4692672e8`
- `s1/executor/vendor/ort/ort-wasm-simd-threaded.wasm`:
  `207d02be4591c156b0a98f024f3d58005b5b04c92274d759fb390338c63559ea`

If the model is ever retrained, re-pin these everywhere (bundle,
`SHA256SUMS`, `VENDOR-MANIFEST.md`, `MODEL_SHA256` in `executor.js`).

## 5. Functionality checks on the preview URL

1. Open the preview with the network tab open. The assistant's trust bar
   must read "0 requests sent" and stay there through a full run
   (intake, model load, stepping, review, Excel download, wipe).
2. Run one full assistant flow end to end: 4-chip intake, template match,
   narrated run, review pass, draft Excel download, wipe. The download must
   carry the "DRAFT FOR REVIEW" banner.
3. COOP/COEP: the vendored ort build is SIMD-threaded and needs
   cross-origin isolation for SharedArrayBuffer. If the model fails to
   initialize on the preview ("WebAssembly multi-threading is not
   supported" in the console), the page needs COOP/COEP headers from the
   Worker before launch; do not ship a silently degraded assistant.
4. Repeat the deploy-checklist box 9 grep on the final page: zero
   `https://` script references.

## 6. IndexNow ping

After the page is live, ping IndexNow for the new/changed guide URLs
(EN + FR) and submit them in Search Console. Use the normal
movahedi.ca publish flow for this step.

## 7. Rollback

1. From the Tier B root:
   `patch -p1 -R < patches/0002-executor-wiring.patch`, then
   `patch -p1 -R < patches/0001-chatbot-panel.patch`
   (reverse order; each patch's header documents this).
2. Delete `demo/s1/`.
3. Rebuild Tier A with `build_astro.py`, remove the 14 S1 hashes and the
   init-block hash from the Worker's `script-src`, redeploy via
   `deploy_site.py`.
4. The page returns to the builder-only state; no assistant code remains
   referenced.

## 8. Mohammad's morning actions (launch checklist, his call)

These boxes cannot be checked by anyone else:

- [ ] Counsel sign-off on `web/legal/DISCLAIMER-DRAFT.md` (deploy checklist
      box 7). THE hard gate: no launch without a completed sign-off block.
      Boxes 6 (draft labeling verified on page + export) and 10 (launch
      writeup) unblock with it.
- [ ] Announcement to the guide's existing audience (box 12), after launch.
- [ ] Search Console submission for the new/changed URLs (box 11),
      alongside the IndexNow ping in section 6.
