import { create } from 'zustand'

export type ToastLevel = 'info' | 'success' | 'warn' | 'error'

export type Toast = {
  id: string
  level: ToastLevel
  title?: string
  message: string
  createdAt: number
  /** Auto-dismiss after N ms. 0 = sticky until dismissed. */
  ttlMs: number
}

export type ToastInput = {
  level: ToastLevel
  title?: string
  message: string
  id?: string
  ttlMs?: number
}

type ToastState = {
  toasts: Toast[]
  push: (toast: ToastInput) => string
  dismiss: (id: string) => void
  clear: () => void
}

const DEFAULT_TTL = 5000

let counter = 0
function nextId(): string {
  counter += 1
  return `t${Date.now().toString(36)}-${counter}`
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (input) => {
    const id = input.id ?? nextId()
    const ttl = input.ttlMs ?? DEFAULT_TTL
    const toast: Toast = {
      id,
      level: input.level,
      title: input.title,
      message: input.message,
      createdAt: Date.now(),
      ttlMs: ttl,
    }
    set({ toasts: [...get().toasts.slice(-4), toast] })
    if (ttl > 0) {
      setTimeout(() => {
        const exists = get().toasts.find((t) => t.id === id)
        if (exists) get().dismiss(id)
      }, ttl)
    }
    return id
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  clear: () => set({ toasts: [] }),
}))

export function toast(input: ToastInput): string {
  return useToastStore.getState().push(input)
}

export function toastError(message: string, opts?: Omit<ToastInput, 'level' | 'message'>): string {
  return toast({ level: 'error', message, ...(opts ?? {}) })
}

export function toastSuccess(message: string, opts?: Omit<ToastInput, 'level' | 'message'>): string {
  return toast({ level: 'success', message, ...(opts ?? {}) })
}

export function toastInfo(message: string, opts?: Omit<ToastInput, 'level' | 'message'>): string {
  return toast({ level: 'info', message, ...(opts ?? {}) })
}

export function toastWarn(message: string, opts?: Omit<ToastInput, 'level' | 'message'>): string {
  return toast({ level: 'warn', message, ...(opts ?? {}) })
}
