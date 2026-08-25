declare module "turndown" {
  export type TurndownPlugin = (service: TurndownService) => void

  export type TurndownOptions = {
    bulletListMarker?: "-" | "+" | "*"
    codeBlockStyle?: "indented" | "fenced"
    emDelimiter?: "_" | "*"
    headingStyle?: "setext" | "atx"
    strongDelimiter?: "**" | "__"
  }

  export default class TurndownService {
    constructor(options?: TurndownOptions)
    turndown(input: string | Node): string
    use(plugin: TurndownPlugin | TurndownPlugin[]): this
  }
}

declare module "turndown-plugin-gfm" {
  import type { TurndownPlugin } from "turndown"

  export const gfm: TurndownPlugin
}
