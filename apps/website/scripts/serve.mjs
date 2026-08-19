// A static server for looking at the site locally. Not what runs in production —
// that is nginx in the image built by ../Dockerfile, on Dokploy — so this
// deliberately does the least it can: no caching, no compression, no directory
// listings, no dependencies.
//
// It exists because the page is edited by hand and file:// lies about enough
// things (relative paths, the download attribute) to be worth avoiding.
import { createReadStream, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, normalize } from "node:path"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "site")
const port = Number(process.env.PORT ?? 6111)

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".yml": "text/yaml; charset=utf-8",
  ".dmg": "application/x-apple-diskimage",
  ".zip": "application/zip"
}

createServer((req, res) => {
  // normalize collapses `..` before it is joined, so a request cannot climb out
  // of site/ into the repo.
  const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "")
  let path = join(root, rel)

  try {
    if (statSync(path).isDirectory()) path = join(path, "index.html")
    const size = statSync(path).size
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "content-length": size,
      "cache-control": "no-store"
    })
    createReadStream(path).pipe(res)
  } catch {
    res.writeHead(404, { "content-type": "text/plain" })
    res.end("not found")
  }
}).listen(port, () => console.log(`site → http://localhost:${port}`))
