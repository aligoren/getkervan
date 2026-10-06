import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import type { LookupFunction } from "node:net"
import type { Transform } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import { ToolError } from "@kervan/core"

export interface HttpCall {
  method: string
  url: URL
  headers: Record<string, string>
  body?: string
}

export interface HttpLimits {
  timeoutMs: number
  maxResponseBytes: number
}

export interface HttpOptions extends HttpLimits {
  signal?: AbortSignal
  /** DNS lookup used to connect (the SSRF layer pins validated addresses through this). */
  lookup?: LookupFunction
}

export interface HttpResponse {
  status: number
  statusText: string
  contentType: string
  body: Buffer
}

/**
 * Makes one request. Redirects are never followed; bodies are counted while streaming and after
 * decompression, so neither a large response nor a compression bomb gets past `maxResponseBytes`.
 * Error messages name only the host: never the path, query or body, which may hold secrets.
 */
export function sendHttp(call: HttpCall, options: HttpOptions): Promise<HttpResponse> {
  const host = call.url.host
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const send = call.url.protocol === "https:" ? httpsRequest : httpRequest

  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const abortError = () =>
      timeout.aborted
        ? new ToolError(`Request to ${host} timed out after ${options.timeoutMs} ms.`)
        : new ToolError(`Request to ${host} was cancelled.`)

    const req = send(
      call.url,
      {
        method: call.method,
        headers: {
          "accept-encoding": "gzip, deflate, br",
          ...call.headers,
          ...(call.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(call.body)) }),
        },
        signal,
        ...(options.lookup ? { lookup: options.lookup } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          res.destroy()
          fail(
            new ToolError(
              `Request to ${host} was redirected (${status}); redirects are not followed.`,
            ),
          )
          return
        }
        readBody(res, options.maxResponseBytes, host).then(
          (body) => {
            if (settled) return
            settled = true
            resolve({
              status,
              statusText: res.statusMessage ?? "",
              contentType: String(res.headers["content-type"] ?? ""),
              body,
            })
          },
          (error: Error) => fail(signal.aborted ? abortError() : error),
        )
      },
    )
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (signal.aborted) return fail(abortError())
      fail(new ToolError(`Request to ${host} failed${error.code ? ` (${error.code})` : ""}.`))
    })
    if (call.body !== undefined) req.write(call.body)
    req.end()
  })
}

function decoderFor(encoding: string | undefined): Transform | undefined {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return createGunzip()
    case "deflate":
      return createInflate()
    case "br":
      return createBrotliDecompress()
    default:
      return undefined
  }
}

function readBody(res: IncomingMessage, limit: number, host: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooLarge = () =>
      new ToolError(`The response from ${host} is larger than ${limit} bytes; it was not read.`)
    const declared = Number(res.headers["content-length"])
    if (Number.isFinite(declared) && declared > limit) {
      res.destroy()
      reject(tooLarge())
      return
    }
    const encoding = res.headers["content-encoding"]
    const decoder = decoderFor(Array.isArray(encoding) ? encoding[0] : encoding)
    if (encoding && !decoder && encoding !== "identity") {
      res.destroy()
      reject(new ToolError(`The response from ${host} uses an unsupported encoding.`))
      return
    }
    const stream = decoder ? res.pipe(decoder) : res
    const chunks: Buffer[] = []
    let size = 0
    let rawSize = 0
    res.on("data", (chunk: Buffer) => {
      rawSize += chunk.length
      if (rawSize > limit) {
        res.destroy()
        decoder?.destroy()
        reject(tooLarge())
      }
    })
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        res.destroy()
        decoder?.destroy()
        reject(tooLarge())
        return
      }
      chunks.push(chunk)
    })
    stream.on("end", () => resolve(Buffer.concat(chunks)))
    stream.on("error", () =>
      reject(new ToolError(`The response from ${host} could not be decoded.`)),
    )
    res.on("error", (error) => reject(error))
  })
}

export function isJsonContentType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
  return type === "application/json" || type.endsWith("+json")
}

export function isTextContentType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
  return type.startsWith("text/") || isJsonContentType(contentType)
}
