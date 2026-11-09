import { requestUrl } from 'obsidian'

/**
 * The SDK's HTTP client contract (`@rushdb/javascript-sdk`, `network/HttpClient.ts`),
 * restated so the plugin depends on its shape only.
 */
export interface MakeRequestConfig {
  headers?: Record<string, string | number | string[] | undefined>
  method: string
  requestData?: unknown
  timeout?: number
}

export interface HttpClientResponse {
  getHeaders: () => Record<string, string>
  getRawResponse: () => unknown
  getStatusCode: () => number
  toJSON: () => Promise<unknown>
  toStream: (streamCompleteCallback: () => void) => unknown
}

export interface HttpClient {
  makeRequest: (url: string, config: MakeRequestConfig) => Promise<HttpClientResponse>
}

export interface RawResponse {
  status: number
  headers: Record<string, string>
  text: string
}

export type Transport = (request: {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}) => Promise<RawResponse>

/** Obsidian's `requestUrl`: no CORS restrictions, and it works on mobile. */
export const obsidianTransport: Transport = async ({ url, method, headers, body }) => {
  const res = await requestUrl({ url, method, headers, body, throw: false })
  return { status: res.status, headers: res.headers, text: res.text }
}

const toHeaders = (headers: MakeRequestConfig['headers'] = {}) => {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

/** Builds an SDK HTTP client over a transport; the transport is swappable in tests. */
export const createHttpClient = (transport: Transport = obsidianTransport): HttpClient => ({
  async makeRequest(url, { headers, method, requestData }) {
    const hasPayload = method === 'POST' || method === 'PUT' || method === 'PATCH'
    const body = requestData === undefined ? (hasPayload ? '' : undefined) : JSON.stringify(requestData)
    const raw = await transport({ url, method, headers: toHeaders(headers), body })
    return {
      getHeaders: () => raw.headers,
      getRawResponse: () => raw,
      getStatusCode: () => raw.status,
      toJSON: async () => (raw.text ? (JSON.parse(raw.text) as unknown) : null),
      toStream: (done) => {
        done()
        return raw.text
      }
    }
  }
})
