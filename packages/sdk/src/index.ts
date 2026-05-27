export type VibeContext = {
  session: {
    id: string
    workspace: string
  }
  log: {
    info(message: string, data?: unknown): void
    warn(message: string, data?: unknown): void
    error(message: string, data?: unknown): void
  }
}

export type VibeHandler = (request: Request, context: VibeContext) => Response | Promise<Response>

export async function callHandler<TResponse = unknown>(path: string, init?: RequestInit): Promise<TResponse> {
  const response = await fetch(path, init)
  if (!response.ok) {
    throw new Error(`Show handler failed: ${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<TResponse>
}
