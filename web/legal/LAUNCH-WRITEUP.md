# Launch writeup (draft)

> DRAFT. This writeup does not publish until counsel signs off the disclaimer and liability copy (web/legal/DISCLAIMER-DRAFT.md). No launch without it.

## The draft inventory assistant is live

Most small companies in Quebec know they need to get their data house in order for Law 25, and the tools on the market were built for someone else. Enterprise suites want a contract and an implementation project. Spreadsheets work, but someone has to fill them in by hand, row by row.

This assistant sits between those two. Four taps, no typing, and it builds your data map in front of you: nodes bloom on the canvas while a step log narrates what it is doing. Twenty seconds later you have a draft inventory, a review loop that asks you to confirm or fix every auto-placed node, and a one-click Excel download you hand to your lawyer on Monday morning. Then you wipe the session and nothing persists.

It is built for two kinds of visitor. The OneTrust refugee who wants the inventory without the enterprise contract. The spreadsheet user who already tracks this in Excel and wants the filling-in done for them. The site's own export format round-trips with no mapping step: upload the file the tool gave you and you get your map back.

## Under the hood

The reflexes come from a tiny custom transformer, 1,382,017 parameters, trained to pick the next action in a guided workflow from the current state and the menu of valid actions. It runs in your browser through onnxruntime-web, exported to ONNX opset 17. No data leaves the device to make it work: there is a live "0 requests sent" counter on the page, and the pre-launch audit procedure is documented in the DPIA.

Training data came from a scripted teacher, not an LLM: 526 labeled steps in 33 shards, deterministic and reproducible from seeds. 152 of those steps are adversarial recovery sessions, so the model learns to recover when a run goes wrong. The vocabulary is domain-agnostic on purpose: 207 of the 526 steps come from unrelated workflows (conference planning, incident response, hiring pipelines, warehouse zones), which is the proof that the executor is a reusable module, not a memorized script.

Everything is open source under MIT: the code at github.com/movahedi-ca/AI-data-map, the model at huggingface.co/movahedi-ca/s1-workflow-tiny, the dataset at huggingface.co/datasets/movahedi-ca/ai-data-map-teacher.

## The numbers

| Measure | Result |
|---|---|
| In-domain menu-choice accuracy (319 steps) | 0.9561 |
| Out-of-domain accuracy, unseen domains and action names (207 steps) | 0.9420 |
| Menu-permutation drift (model reads the menu, not positions) | 0.00 |
| Final train loss (12 epochs, CPU) | 0.2145 |
| Model size | 1,382,017 params, ONNX opset 17 |

## The honest part

This is a draft aid, not legal advice. Every output is a draft inventory for your lawyer to review. The tool never calls its output lawyer-ready, compliant, or finished.

The model is a reflex, not a planner: it picks one action at a time from the menu it is given. It cannot invent actions, and its recovery behavior is only as good as the corrupted sessions it trained on. It trained on synthetic data, which keeps it clean of real personal data and keeps it honest about the gap between the lab and your office.

Retention periods are ranges with the statute cited and an as-of date, because statutory periods are floors and edge cases extend them. Anything the tool cannot verify is flagged "verify" instead of given a number. Law 25 sets no numerical retention periods itself; it tells you to destroy or anonymize data once the purpose is fulfilled, subject to periods set by other laws. Any number in your inventory comes from those other laws.

The strongest privacy claim lives in the offline bundle: download the single file, disconnect, and the full flow runs with the wifi off. The live page states the audited claim next to its counter.

Four taps to start. A map you can watch being built. A draft you review, not a verdict you are handed.
