'use client'

import { useState } from 'react'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { useTranslation } from '@/hooks/use-translation'

const ACK_KEY = 'p13:recovery_mnemonic_ack'

export function SettingsRecoveryMnemonic() {
  const { t } = useTranslation()
  const [phrase, setPhrase] = useState<string | null>(null)
  const [ack, setAck] = useState(false)

  function generate() {
    const m = generateMnemonic(wordlist, 128)
    setPhrase(m)
    setAck(false)
    try {
      window.localStorage.removeItem(ACK_KEY)
    } catch {
      /* ignore */
    }
  }

  function confirmSaved() {
    try {
      window.localStorage.setItem(ACK_KEY, '1')
    } catch {
      /* ignore */
    }
    setPhrase(null)
    setAck(false)
  }

  return (
    <div className="border-t border-neon-cyan/30 pt-3">
      <p className="mb-1 text-xs uppercase tracking-widest text-neon-cyan">
        {t('settings.recoveryMnemonicTitle')}
      </p>
      <p className="mb-2 text-[9px] text-red-800">{t('settings.recoveryMnemonicHint')}</p>
      {!phrase ? (
        <button
          type="button"
          onClick={generate}
          className="border border-neon-cyan/60 bg-black px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10"
        >
          [ {t('settings.recoveryMnemonicGenerate')} ]
        </button>
      ) : (
        <div className="space-y-2 border border-neon-red/40 p-2">
          <p className="text-[9px] uppercase text-neon-red">{t('settings.recoveryMnemonicWarn')}</p>
          <p className="break-words font-mono text-[11px] leading-relaxed text-neon-cyan">
            {phrase}
          </p>
          <label className="flex cursor-pointer items-center gap-2 text-[10px] text-zinc-400">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="border-neon-cyan"
            />
            {t('settings.recoveryMnemonicAck')}
          </label>
          <button
            type="button"
            disabled={!ack}
            onClick={confirmSaved}
            className="border border-neon-cyan px-2 py-1 font-mono text-[10px] uppercase text-neon-cyan disabled:opacity-30"
          >
            [ {t('settings.recoveryMnemonicDone')} ]
          </button>
        </div>
      )}
    </div>
  )
}
