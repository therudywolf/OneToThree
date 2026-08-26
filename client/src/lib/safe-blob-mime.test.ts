// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

/**
 * Sending source files became possible; this is the half of that change that
 * keeps it from being a hole.
 *
 * A `blob:` URL inherits the origin of the page that made it, so an attachment
 * blob typed `text/html` is a document that runs script in the app's own origin
 * — where the vault's IndexedDB lives — and reaching it costs one "open in new
 * tab" on a download button. The type comes from the SENDER's envelope, so it
 * is the sender's choice.
 */

import { describe, expect, it } from 'vitest'
import { safeBlobMime } from './safe-blob-mime'

const OCTET = 'application/octet-stream'

describe('safeBlobMime', () => {
  it('leaves media that is actually rendered alone', () => {
    for (const mime of [
      'image/png',
      'image/jpeg',
      'image/webp',
      'video/mp4',
      'video/webm',
      'audio/ogg',
      'application/pdf',
      'text/plain',
      'application/json',
      'application/zip',
    ]) {
      expect(safeBlobMime(mime, 'file.bin')).toBe(mime)
    }
  })

  it('preserves codec parameters on media that keeps its type', () => {
    expect(safeBlobMime('audio/webm;codecs=opus', 'voice.weba')).toBe(
      'audio/webm;codecs=opus'
    )
  })

  it('neutralizes every type a browser would run as a document', () => {
    for (const mime of [
      'text/html',
      'TEXT/HTML',
      'text/html; charset=utf-8',
      'application/xhtml+xml',
      'text/xml',
      'application/xml',
      'image/svg+xml',
      'application/javascript',
      'text/javascript',
    ]) {
      expect(safeBlobMime(mime, 'thing.txt')).toBe(OCTET)
    }
  })

  it('neutralizes on the EXTENSION even when the type looks harmless', () => {
    // The extension is what an OS file handler follows once the file is saved,
    // and a .html written out of a text/plain blob is still an HTML file to
    // whatever opens it next.
    for (const name of ['page.html', 'page.HTM', 'app.js', 'mod.mjs', 'logo.svg']) {
      expect(safeBlobMime('text/plain', name)).toBe(OCTET)
    }
  })

  it('does not trip over names with no extension, dots, or paths', () => {
    expect(safeBlobMime('image/png', 'screenshot')).toBe('image/png')
    expect(safeBlobMime('image/png', '.gitignore')).toBe('image/png')
    expect(safeBlobMime('image/png', 'my.photo.album.png')).toBe('image/png')
    expect(safeBlobMime('image/png', null)).toBe('image/png')
    expect(safeBlobMime('image/png', undefined)).toBe('image/png')
  })

  it('is not fooled by a path in the file name', () => {
    expect(safeBlobMime('text/plain', 'dir/sub/evil.html')).toBe(OCTET)
    expect(safeBlobMime('text/plain', 'dir\\sub\\evil.html')).toBe(OCTET)
  })
})
