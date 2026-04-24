'use client'

import {
  createJSONStorage,
  type StateStorage,
} from 'zustand/middleware'

const memoryStorageData = new Map<string, string>()

const memoryStorage: StateStorage = {
  getItem: (name) => memoryStorageData.get(name) ?? null,
  setItem: (name, value) => {
    memoryStorageData.set(name, value)
  },
  removeItem: (name) => {
    memoryStorageData.delete(name)
  },
}

function isStateStorageLike(value: unknown): value is StateStorage {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as StateStorage).getItem === 'function' &&
      typeof (value as StateStorage).setItem === 'function' &&
      typeof (value as StateStorage).removeItem === 'function'
  )
}

function resolveLocalStorageCandidate(): StateStorage {
  try {
    const candidate = globalThis.localStorage
    if (isStateStorageLike(candidate)) {
      return candidate
    }
  } catch {
    // Fall back to in-memory storage when localStorage is unavailable or malformed.
  }
  return memoryStorage
}

export function createSafeJSONStorage<T>() {
  return createJSONStorage<T>(() => resolveLocalStorageCandidate())
}
