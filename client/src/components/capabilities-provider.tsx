'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { ALL_ON, fetchCapabilities, type Capabilities } from '@/lib/api/capabilities'

/**
 * Provides this instance's feature capabilities (OneToThree **Lite** self-host).
 * Defaults to ALL_ON so the full build — and the first paint before the probe
 * resolves — never hides a working surface; a feature is gated off only after the
 * server explicitly reports it disabled. See lib/api/capabilities.ts.
 *
 * Exported so tests (and any SSR/preview injection) can supply a fixed value via
 * `<CapabilitiesContext.Provider value={…}>` without the network fetch.
 */
export const CapabilitiesContext = createContext<Capabilities>(ALL_ON)

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [caps, setCaps] = useState<Capabilities>(ALL_ON)

  useEffect(() => {
    let alive = true
    void fetchCapabilities().then((c) => {
      if (alive) setCaps(c)
    })
    return () => {
      alive = false
    }
  }, [])

  return <CapabilitiesContext.Provider value={caps}>{children}</CapabilitiesContext.Provider>
}

/** All capability flags. Defaults to ALL_ON until the probe resolves. */
export function useCapabilities(): Capabilities {
  return useContext(CapabilitiesContext)
}

/** A single capability flag, e.g. `useCapability('calls')`. */
export function useCapability(key: keyof Capabilities): boolean {
  return useContext(CapabilitiesContext)[key]
}
