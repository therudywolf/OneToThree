'use client'

/**
 * PROJECT 13 :: CALL_PIP_HELPERS
 * Level: Presentation (Picture-in-Picture)
 *
 * Two escape hatches for taking a call out of the tab:
 *  - Video PiP: the classic floating <video> (wide support incl. Safari).
 *  - Document PiP: a real always-on-top mini window that can host arbitrary
 *    DOM (Chromium 116+). The overlay renders a React portal into it.
 */

type DocumentPictureInPicture = {
  requestWindow: (opts?: { width?: number; height?: number }) => Promise<Window>
  window: Window | null
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture
  }
}

export function isVideoPipSupported(): boolean {
  if (typeof document === 'undefined') return false
  return 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled
}

export function isDocPipSupported(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window
}

/** Toggle native video PiP on an element. Returns whether PiP is now active. */
export async function toggleVideoPip(video: HTMLVideoElement): Promise<boolean> {
  try {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture()
      return false
    }
    await video.requestPictureInPicture()
    return true
  } catch (err) {
    console.warn('[pip] video PiP failed', err)
    return document.pictureInPictureElement === video
  }
}

/**
 * Open a Document PiP window and clone the app's stylesheets into it so
 * portal-rendered content keeps the design tokens. Returns null when
 * unsupported or blocked.
 */
export async function openDocPipWindow(opts: {
  width: number
  height: number
}): Promise<Window | null> {
  const api = typeof window !== 'undefined' ? window.documentPictureInPicture : undefined
  if (!api) return null
  let pipWindow: Window
  try {
    pipWindow = await api.requestWindow({ width: opts.width, height: opts.height })
  } catch (err) {
    console.warn('[pip] document PiP request failed', err)
    return null
  }

  // Copy style sheets (same-origin <style>/<link>) so the portal looks native.
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules
      const style = pipWindow.document.createElement('style')
      style.textContent = Array.from(rules)
        .map((r) => r.cssText)
        .join('\n')
      pipWindow.document.head.appendChild(style)
    } catch {
      // Cross-origin sheet — link it instead.
      const href = (sheet as CSSStyleSheet).href
      if (href) {
        const link = pipWindow.document.createElement('link')
        link.rel = 'stylesheet'
        link.href = href
        pipWindow.document.head.appendChild(link)
      }
    }
  }
  // Carry theme classes/attributes over (design tokens hang off <html>/<body>).
  pipWindow.document.documentElement.className = document.documentElement.className
  const dataset = document.documentElement.attributes
  for (const attr of Array.from(dataset)) {
    if (attr.name.startsWith('data-')) {
      pipWindow.document.documentElement.setAttribute(attr.name, attr.value)
    }
  }
  pipWindow.document.body.className = document.body.className
  pipWindow.document.body.style.margin = '0'
  pipWindow.document.body.style.background = 'var(--void, #000)'
  return pipWindow
}
