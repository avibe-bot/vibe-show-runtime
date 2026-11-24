import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from "node:http"

// sirv (Vite's static middleware) uses decimal size + millisecond mtime, not
// file content. Scope its validators to the observed workspace revision. Leave
// Vite's content-based transform ETags and status/range handling untouched.
const staticTag = /^W\/"(\d+--?\d+)"$/
export function scopeStaticValidators(req: IncomingMessage, res: ServerResponse, revision: string) {
  const tag = req.headers["if-none-match"] ?? ""
  const scoped = /^W\/"show:([^:]+):(\d+--?\d+)"$/.exec(tag)
  if (scoped?.[1] === revision) req.headers["if-none-match"] = `W/"${scoped[2]}"`
  else if (scoped || staticTag.test(tag)) delete req.headers["if-none-match"]
  delete req.headers["if-modified-since"]

  const writeHead = res.writeHead.bind(res)
  res.writeHead = function (status, reason?: string | OutgoingHttpHeaders | OutgoingHttpHeader[], fields?: OutgoingHttpHeaders | OutgoingHttpHeader[]) {
    const headers = typeof reason === "string" ? fields : reason
    if (headers && !Array.isArray(headers)) {
      const record = headers as OutgoingHttpHeaders
      const match = typeof record.ETag === "string" && staticTag.exec(record.ETag)
      if (match) record.ETag = `W/"show:${revision}:${match[1]}"`
    }
    return typeof reason === "string" ? writeHead(status, reason, fields) : writeHead(status, reason)
  }
}
