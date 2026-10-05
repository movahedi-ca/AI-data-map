# IndexNow ping for AI-data-map

The assistant tool pages are submitted to search engines through
[IndexNow](https://www.indexnow.org/documentation) at launch, so Bing and
other participating engines pick the new pages up without waiting for a
crawl.

## How it runs

- `submit-indexnow.js` reads the URL list from `urls.txt` and POSTs it to
  `https://api.indexnow.org/indexnow` per the IndexNow protocol. Node stdlib
  only, no dependencies.
- The ping runs once at launch of the assistant pages, from the deployment
  environment, not from CI and not from the repo.
- The IndexNow key belongs to the movahedi.ca site. It is passed to the
  script as a command-line argument and never stored in the repo, never
  written to a file here, and never committed.

## Usage

```sh
node tools/indexnow/submit-indexnow.js <indexnow-key>
```

The script validates the key shape, requires every URL to share one host,
derives the key file location as `https://<host>/<key>.txt` (the key file
must be published at that movahedi.ca path before pinging), and exits
non-zero if api.indexnow.org rejects the submission.
