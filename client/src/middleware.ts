import type { NextRequest } from 'next/server'
import { config as proxyConfig, proxy } from './proxy'

export const config = proxyConfig

export async function middleware(request: NextRequest) {
  return proxy(request)
}
