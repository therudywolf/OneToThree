import { HomeClient } from '@/components/home-client'

/**
 * PROJECT 13 :: MAIN_SECTOR_ENTRY
 * Level: Internal Layer (Authenticated Dashboard)
 * Vibe: Clinical Pure / Zero-Trust Lane
 * Purpose: Gateway to the active communication sector.
 */

// Страница рендерится как клиентский shell; для export используем default static behavior.

export default function Home() {
  /**
   * Мы передаем управление HomeClient. 
   * Весь тяжелый обвес (чаты, списки, линки) разворачивается там.
   */
  return <HomeClient />
}