#!/usr/bin/env tsx
// No-CLI manual login: opens chat.qwen.ai in a visible Chromium window,
// waits for you to log in once (visually — no CLI prompts, no typed creds here),
// then PERSISTS the session (saveStorageState) + registers the account.
//
// Fixes the bug in upstream login.ts option [M] which detected the session
// but never saved it, so manual logins were lost on close.
//
// Usage:  npx tsx scripts/manual-login.ts <email>
import 'dotenv/config'
import crypto from 'crypto'
import { launchManualLoginAccount, extractAccountInfoFromContext, saveStorageState } from '../src/services/browser-manager.js'
import { addAccount, listAccounts } from '../src/core/accounts.js'

const email = (process.argv[2] || process.env.QWEN_EMAIL || '').trim()
if (!email) {
  console.error('Usage: npx tsx scripts/manual-login.ts <email>')
  process.exit(2)
}

const accountId = crypto.randomUUID()
console.log(`[manual-login] opening chat.qwen.ai for ${email} (accountId=${accountId})`)
console.log(`[manual-login] log in once in the browser window that just opened. I will auto-detect + save it.`)

const { context, page } = await launchManualLoginAccount(accountId, 'chromium')

const closeBrowser = async () => { try { await context.close() } catch (_) {} }
context.on('close', () => { console.log('[manual-login] browser window closed.') })

const deadline = Date.now() + 15 * 60 * 1000 // 15 min ceiling
let saved = false
while (Date.now() < deadline) {
  try {
    const { hasSession, email: detected } = await extractAccountInfoFromContext(page)
    if (hasSession) {
      console.log(`[manual-login] session detected${detected ? ` (email=${detected})` : ''}. Saving...`)
      await saveStorageState(context, accountId)
      addAccount(email, '', accountId)
      saved = true
      console.log(`[manual-login] SUCCESS — account saved: ${email} (${accountId})`)
      console.log(`[manual-login] accounts now: ${listAccounts().map(a => a.email).join(', ') || '(none)'}`)
      await new Promise(r => setTimeout(r, 1500))
      break
    }
  } catch (err: any) {
    // page closed / navigated — keep looping until deadline unless context gone
    if (context.pages().length === 0 && !saved) {
      console.log(`[manual-login] context closed before session saved: ${err.message}`)
      break
    }
  }
  await new Promise(r => setTimeout(r, 2000))
}

await closeBrowser()
console.log(saved ? '[manual-login] DONE — you can now start the server.' : '[manual-login] no session saved (timed out or closed). Re-run and log in.')
process.exit(saved ? 0 : 1)
