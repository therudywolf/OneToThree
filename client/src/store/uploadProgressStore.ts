/**
 * Sprint M1-5 — active-upload registry. Each row tracks one in-flight
 * presigned PUT so the chat input can render a progress bar with cancel.
 *
 * Lifecycle: addUpload() → setProgress() (many) → finishUpload() / failUpload().
 * cancelUpload() aborts the underlying XHR via the stored AbortController.
 */
import { create } from 'zustand'

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'cancelled'

export type UploadEntry = {
  id: string
  fileName: string
  totalBytes: number
  loadedBytes: number
  status: UploadStatus
  errorMessage?: string
}

type UploadStore = {
  uploads: Record<string, UploadEntry>
  controllers: Record<string, AbortController>
  addUpload: (id: string, fileName: string, totalBytes: number, controller: AbortController) => void
  setProgress: (id: string, loadedBytes: number, totalBytes?: number) => void
  setStatus: (id: string, status: UploadStatus, errorMessage?: string) => void
  cancelUpload: (id: string) => void
  removeUpload: (id: string) => void
}

export const useUploadProgressStore = create<UploadStore>((set, get) => ({
  uploads: {},
  controllers: {},
  addUpload: (id, fileName, totalBytes, controller) =>
    set((s) => ({
      uploads: {
        ...s.uploads,
        [id]: { id, fileName, totalBytes, loadedBytes: 0, status: 'uploading' },
      },
      controllers: { ...s.controllers, [id]: controller },
    })),
  setProgress: (id, loadedBytes, totalBytes) =>
    set((s) => {
      const entry = s.uploads[id]
      if (!entry) return s
      return {
        uploads: {
          ...s.uploads,
          [id]: {
            ...entry,
            loadedBytes,
            totalBytes: totalBytes ?? entry.totalBytes,
          },
        },
      }
    }),
  setStatus: (id, status, errorMessage) =>
    set((s) => {
      const entry = s.uploads[id]
      if (!entry) return s
      return {
        uploads: { ...s.uploads, [id]: { ...entry, status, errorMessage } },
      }
    }),
  cancelUpload: (id) => {
    const ctrl = get().controllers[id]
    if (ctrl) ctrl.abort()
    set((s) => {
      const entry = s.uploads[id]
      if (!entry) return s
      return {
        uploads: { ...s.uploads, [id]: { ...entry, status: 'cancelled' } },
      }
    })
  },
  removeUpload: (id) =>
    set((s) => {
      const { [id]: _u, ...rest } = s.uploads
      const { [id]: _c, ...restCtrl } = s.controllers
      return { uploads: rest, controllers: restCtrl }
    }),
}))
