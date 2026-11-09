import { describe, expect, it } from 'vitest'

import { createHttpClient, type Transport } from '../src/http'

describe('createHttpClient', () => {
  it('sends JSON and parses the response', async () => {
    const calls: Parameters<Transport>[0][] = []
    const client = createHttpClient(async (req) => {
      calls.push(req)
      return { status: 200, headers: { 'content-type': 'application/json' }, text: '{"success":true}' }
    })
    const res = await client.makeRequest('https://x/api/v1/records', {
      method: 'POST',
      headers: { token: 't' },
      requestData: { a: 1 }
    })
    expect(calls).toEqual([{ url: 'https://x/api/v1/records', method: 'POST', headers: { token: 't' }, body: '{"a":1}' }])
    expect(res.getStatusCode()).toBe(200)
    expect(await res.toJSON()).toEqual({ success: true })
  })

  it('sends no body on GET and handles empty responses', async () => {
    let body: string | undefined = 'unset'
    const client = createHttpClient(async (req) => {
      body = req.body
      return { status: 204, headers: {}, text: '' }
    })
    const res = await client.makeRequest('https://x', { method: 'GET' })
    expect(body).toBeUndefined()
    expect(await res.toJSON()).toBeNull()
  })
})
