// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * The MIME type a DECRYPTED attachment may be given when it becomes a Blob.
 *
 * A `blob:` URL inherits the origin of the page that created it. An attachment
 * blob typed `text/html` is therefore a document that runs script in the app's
 * own origin — with reach into the IndexedDB the vault lives in — and it only
 * takes one "open link in new tab" on the download button to get there. The
 * `download` attribute prevents navigation on a left click; it does not prevent
 * a context menu.
 *
 * The type comes from the sender's envelope, so it is the sender's choice, not
 * the server's: source and markup attachments are stored as opaque bytes (see
 * `storedContentType` in server/src/routes/storage.ts) but the envelope still
 * carries `text/html` because that is what the file honestly is, and the file
 * card needs it to label the row. So the neutralization has to be applied again
 * here, on the way OUT of decryption.
 *
 * Nothing is lost by it: these types are never rendered inline anywhere in the
 * app — they are download links and file cards. Media that IS rendered (images,
 * audio, video, PDF) keeps its real type and its inline preview.
 */

const OCTET_STREAM = 'application/octet-stream'

/** Types a browser will treat as an active document in the creating origin. */
const ACTIVE_DOCUMENT_MIMES = new Set([
  'text/html',
  'text/x-html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'text/xsl',
  'application/xslt+xml',
  'image/svg+xml',
  'image/svg',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'text/ecmascript',
  'application/ecmascript',
  'application/mathml+xml',
])

/**
 * Extensions that must not carry an active type even when the envelope claims
 * something harmless — the extension is what an OS file handler follows once
 * the file is on disk, and a `.html` saved from a `text/plain` blob is still an
 * HTML file to the browser that opens it next.
 */
const ACTIVE_DOCUMENT_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'shtml', 'xml', 'xsl', 'xslt', 'svg',
  'js', 'mjs', 'cjs', 'jsx',
])

function baseType(mime: string): string {
  return mime.toLowerCase().split(';')[0].trim()
}

function extensionOf(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * @param declaredMime what the sender's envelope says the file is
 * @param fileName the envelope's file name, when there is one
 * @returns the type to hand `new Blob(...)` — the declared one, or opaque bytes
 */
export function safeBlobMime(declaredMime: string, fileName?: string | null): string {
  const lower = baseType(declaredMime)
  if (ACTIVE_DOCUMENT_MIMES.has(lower)) return OCTET_STREAM
  if (fileName && ACTIVE_DOCUMENT_EXTENSIONS.has(extensionOf(fileName))) return OCTET_STREAM
  return declaredMime
}
