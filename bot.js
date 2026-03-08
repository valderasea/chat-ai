import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} from '@blckrose/baileys'
import pino from 'pino'
import axios from 'axios'
import fs from 'node:fs'
import path from 'node:path'

const PAIR_NUMBER = '6285888265103'

const SESSION_DIR = './session'
const DB_PATH = './database/chat_history.json'
const BLACKLIST_PATH = './blacklist.json'
const MAX_HISTORY = 30

const logger = pino({ level: 'silent' })

let pairingRequested = false
let restarting = false
let writeQueue = Promise.resolve()

function ensureFile(filePath, defaultValue) {
  try {
    fs.accessSync(filePath)
  } catch {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, defaultValue, 'utf8')
  }
}

function initFiles() {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
  ensureFile(DB_PATH, '{}')
  ensureFile(BLACKLIST_PATH, '[]')
}

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function getBlacklist() {
  const data = readJSON(BLACKLIST_PATH, [])
  if (!Array.isArray(data)) return []

  return data
    .map(v => String(v).replace(/\D/g, '').trim())
    .filter(Boolean)
}

function getHistory(chatId) {
  const db = readJSON(DB_PATH, {})
  return Array.isArray(db[chatId]) ? db[chatId] : []
}

function pushHistory(chatId, role, content) {
  writeQueue = writeQueue.then(() => {
    const db = readJSON(DB_PATH, {})
    if (!Array.isArray(db[chatId])) db[chatId] = []

    db[chatId].push({ role, content })
    db[chatId] = db[chatId].slice(-MAX_HISTORY)

    writeJSON(DB_PATH, db)
  }).catch(err => {
    console.error('[DB ERROR]', err?.message || err)
  })
}

function getText(msg) {
  return (
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption ||
    ''
  )
}

function getSenderNumber(m) {
  const raw =
    m?.key?.participant ||
    m?.participant ||
    m?.pushNameParticipant ||
    m?.key?.remoteJid ||
    ''

  return String(raw).split('@')[0].replace(/\D/g, '')
}

async function askAI(chatId, text) {
  const history = getHistory(chatId)

  const messages = [
    {
      role: 'assistant',
      content: 'Nama kamu adalah vall. Kamu asisten chat WhatsApp. Jawab singkat, santai, natural, bahasa Indonesia. Jangan panjang.'
    },
    ...history,
    { role: 'user', content: text }
  ]

  const { data } = await axios.post(
    'https://nexra.aryahcr.cc/api/chat/completions',
    {
      messages,
      model: 'chatgpt',
      markdown: false,
      stream: false
    },
    {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 60000
    }
  )

  if (data?.code !== 200) {
    throw new Error(data?.message || 'Nexra error')
  }

  return String(data.message || '').trim() || 'AI error'
}

async function requestPairing(sock) {
  const phone = PAIR_NUMBER.replace(/\D/g, '')

  if (!phone.startsWith('62')) {
    console.log('[PAIR ERROR] nomor wajib format 628xxxx')
    process.exit(1)
  }

  if (pairingRequested) return
  pairingRequested = true

  console.log('[PAIR] requesting code for', phone)

  setTimeout(async () => {
    try {
      const code = await sock.requestPairingCode(phone)
      console.log('\n=== PAIRING CODE ===')
      console.log(code)
      console.log('Masuk WA > Perangkat tertaut > Tautkan dengan nomor telepon\n')
    } catch (err) {
      pairingRequested = false
      console.log('[PAIR ERROR]', err?.message || err)
    }
  }, 3000)
}

async function startBot() {
  initFiles()

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update

    if (!sock.authState?.creds?.registered) {
      await requestPairing(sock)
    }

    if (connection === 'connecting') {
      console.log('[WA] connecting...')
    }

    if (connection === 'open') {
      console.log('[WA] connected')
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const msg = lastDisconnect?.error?.message || 'unknown'
      console.log('[WA] closed:', code, msg)

      if (code !== DisconnectReason.loggedOut) {
        if (!restarting) {
          restarting = true
          setTimeout(() => {
            restarting = false
            startBot()
          }, 3000)
        }
      } else {
        console.log('[WA] logged out, hapus folder session lalu start lagi')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    const m = messages?.[0]
    if (!m?.message) return
    if (m.key?.fromMe) return
    if (m.key?.remoteJid === 'status@broadcast') return

    const chatId = m.key.remoteJid
    if (!chatId) return

    // private only
    if (chatId.endsWith('@g.us')) return

    const sender = getSenderNumber(m)
    const blacklist = getBlacklist()

    console.log('[DEBUG] sender =', sender)
    console.log('[DEBUG] blacklist =', blacklist)

    if (blacklist.includes(sender)) {
      console.log('[BLACKLIST BLOCKED]', sender)
      return
    }

    const text = getText(m.message).trim()
    if (!text) return

    try {
      await sock.sendPresenceUpdate('composing', chatId)

      const reply = await askAI(chatId, text)
      if (!reply) throw new Error('reply kosong')

      pushHistory(chatId, 'user', text)
      pushHistory(chatId, 'assistant', reply)

      await sock.sendMessage(
        chatId,
        { text: reply },
        { quoted: m }
      )
    } catch (err) {
      console.log('[AI ERROR]', err?.response?.data || err?.message || err)

      await sock.sendMessage(
        chatId,
        { text: 'AI lagi error.' },
        { quoted: m }
      )
    }
  })
}

startBot()