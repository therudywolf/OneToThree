import { HomeClient } from '@/components/home-client'

/**
 * PROJECT 13 :: MAIN_SECTOR_ENTRY
 * Level: Internal Layer (Authenticated Dashboard)
 * Vibe: Clinical Pure / Zero-Trust Lane
 * Purpose: Gateway to the active communication sector.
 */

// Форсим динамику, чтобы Zero-Trust токены и сессии проверялись на каждом такте.
export const dynamic = 'force-dynamic'

export default function Home() {
  /**
   * Мы передаем управление HomeClient. 
   * Весь тяжелый обвес (чаты, списки, линки) разворачивается там.
   */
  return <HomeClient />
}