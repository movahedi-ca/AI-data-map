# Subprocessor supply-chain graph

Two levels of subprocessor relationships for the tech index companies, researched 2026-10-05. Built for the AI-data-map project. This dataset is raw material for a future article; no article is written here.

## Scope

87 companies: the union of the S&P 500 Information Technology sector (74 companies, from the GICS sector column of Wikipedia's List of S&P 500 companies, fetched 2026-10-05) and the Nasdaq-100 Technology Sector Index (NDXT) extras not in the S&P 500 IT set (13 companies: Alphabet, AppLovin, Arm, ASML, Astera Labs, CoreWeave, DoorDash, Meta, Nebius, PDD Holdings, Shopify, Strategy, Thomson Reuters; component list from indexes.nasdaq.com NDXT10NR weighting, as of 2026-09-10). The full MSCI US Investable Market Information Technology constituent list is not publicly published; the S&P 500 IT plus NDXT union covers the large and mid-cap US IT universe, and the gap is recorded here rather than filled by guessing.

## Method

Level 1: for each of the 87 companies, researchers found its published subprocessor list (trust center, DPA/subprocessor/legal/privacy pages, regional or product-specific variants, subsidiary brands). GDPR Article 28(2) requires processors to disclose subprocessor additions and replacements, and public lists are the standard compliance mechanism, so every company was expected to have one. A company is marked not-published only after exhaustive search, and then only with a search trail of the pages checked. A missing list is a finding (a possible transparency gap), not a dropped row.

Level 2: for subprocessors appearing in 2 or more index-company lists (the shared supply chain, 41 targets after alias merging), researchers found each target's own published subprocessor list. Outgoing edges of subprocessors that are themselves index companies (Microsoft, Google, Salesforce, Oracle, Adobe, Cisco and others) are synthesized from their level-1 lists and marked synthesized:true. Single-use subprocessors (mostly affiliates) are recorded as edge targets, but their own lists were not chased; that scoping decision is explicit.

Every edge carries its source URL and an as-of date. Purposes and locations are copied verbatim from the source pages; where the source states none, the value is null, never guessed.

## Files

- graph.json: nodes (index companies with ticker, HQ, index source; subprocessors by name) and edges (from, to, level 1 or 2, purpose, location, source, as_of, via, synthesized), plus the not_published records with search trails.
- edges.csv: the same edges in flat form for analysis.

## Coverage

- Index companies with a published list found: 29 of 87.
- Index companies with no published list after exhaustive search: 58 of 87 (search trails in graph.json).
- Level-1 edges: 1,118. Average subprocessors per publishing company: 36.1.
- Level-2 edges: 1,400 (828 researched across 36 shared targets, 572 synthesized from index-company lists).
- Total nodes: 1,499. Total edges: 2,518.
- Level-2 targets with no public list (7): Pendo, Splunk, LexisNexis, SAP SE, SpyCloud, Concentrix, Teleperformance. Splunk's page is bot-filtered (HTTP 403); Pendo's list sits behind a JS trust center. Both are flagged for a live-browser follow-up.

## Highlights

- The supply chain is highly concentrated. The most frequent level-1 subprocessors across the 87 companies are Microsoft (29 lists), Google (29), and Amazon Web Services (26). Three hyperscalers underpin the whole index.
- The longest published lists: Alphabet (157 rows), Palo Alto Networks (107), Motorola Solutions (96), Adobe (80), Gen Digital (73).
- AI labs now appear as subprocessors: OpenAI is named in 8 index-company lists, Anthropic in 4. Microsoft's own pages name Anthropic (Claude in Microsoft 365 Copilot) and xAI (Grok in Office) as subprocessors.
- The 58 companies with no published list are mostly hardware and semiconductor firms (AMD, Intel, Nvidia, Micron, Applied Materials, ASML, Corning and others) plus Apple. Their posture is controller-side privacy policies with no processor disclosure, a pattern worth its own section in the article.
- Chains run deep: AWS's own list names 64 infrastructure affiliates across dozens of countries; Twilio's list runs to 40 rows including its own hyperscaler dependencies; PagerDuty lists both Sumo Logic and Zapier, which are themselves researched level-2 targets.

## Article angles (not written, for later)

1. Three clouds under everyone: quantify hyperscaler concentration across the index.
2. The 58 missing lists: is the hardware sector's Article 28(2) posture a transparency gap?
3. AI models as subprocessors: OpenAI and Anthropic inside enterprise stacks.
4. Depth: pick one chain (e.g. Salesforce to AWS to AWS affiliates) and walk it end to end.
5. Gated lists: vendors that publish lists only behind logins (Workday, NetApp, SAP) and what that means for controller due diligence.

## Limits

- Lists change; every edge is dated 2026-10-05. Treat this as a snapshot.
- Some pages were partially readable (Akamai's main list 403-blocked, Autodesk's list unlocatable, Workday's list login-gated, Cisco's per-product sheets number in the dozens and only the verified ones are included). These are flagged in the search trails.
- Level 2 covers shared subprocessors only; the long tail of single-use affiliates is not expanded.
