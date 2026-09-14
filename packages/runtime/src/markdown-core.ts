import TurndownService from "turndown"
import { gfm } from "turndown-plugin-gfm"

export type MarkdownRenderErrorCode =
  | "invalid_target"
  | "session_unknown"
  | "renderer_unavailable"
  | "render_timeout"
  | "render_failed"
  | "router_not_ssr_capable"
  | "output_too_large"

export class MarkdownRenderError extends Error {
  constructor(
    readonly code: MarkdownRenderErrorCode,
    readonly status: number,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "MarkdownRenderError"
  }
}

export class RouterNotSsrCapableError extends MarkdownRenderError {
  constructor(options?: ErrorOptions) {
    super(
      "router_not_ssr_capable",
      502,
      "This Show Page router does not support Markdown for subpages. Export an SSR-capable SsrRouterProvider from src/router.tsx.",
      options
    )
    this.name = "RouterNotSsrCapableError"
  }
}

export function convertRenderedHtmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    headingStyle: "atx",
    strongDelimiter: "**"
  })
  turndown.use(gfm)
  const markdown = turndown.turndown(html).trim()
  return markdown ? `${markdown}\n` : ""
}
