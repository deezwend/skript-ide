/**
 * `list_sessions` / `send_to_session`: agent aynı anda açık olan diğer konuşmaların agent'larıyla
 * mesajlaşır. Teslim, kuyruk ve uyandırma masaüstü uygulamasının işidir (`ToolContext.sessions`).
 */
import { conversationLabel, shortId } from '../conversations'
import { defineTool, ToolError, type SessionMessenger, type SessionPeer, type ToolContext } from '../tool'

/** Alt agent'lara verilmeyen tool'lar: alt agent yalnızca ana agent'a rapor verir. */
export const SESSION_TOOL_NAMES: readonly string[] = ['list_sessions', 'send_to_session']

const DEFAULT_LIMIT = 15
const MAX_LIMIT = 50
/** Onay özetinde gösterilen mesaj uzunluğu. */
const PREVIEW_CHARS = 200

function messengerOf(ctx: ToolContext): SessionMessenger {
  if (!ctx.sessions) throw new ToolError('Messaging other sessions is not available here.')
  return ctx.sessions
}

function statusText(peer: SessionPeer): string {
  const status = peer.status === 'approval' ? 'running, waiting for user approval' : peer.status
  return peer.queued > 0 ? `${status}, ${peer.queued} queued message(s)` : status
}

export const listSessionsTool = defineTool<{ limit?: number; active_only?: boolean }>({
  name: 'list_sessions',
  description:
    'List the user\'s other conversations (sessions) you can message with send_to_session, most recent first, with their ' +
    'status: running (its agent is working now), idle, or waiting for approval. Read one\'s transcript with read_conversation.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: `Maximum results (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).` },
      active_only: { type: 'boolean', description: 'Only list sessions whose agent is running now.' }
    },
    additionalProperties: false
  },
  permission: 'read',
  async execute({ limit = DEFAULT_LIMIT, active_only = false }, ctx) {
    const peers = (await messengerOf(ctx).list()).filter((peer) => !active_only || peer.status !== 'idle')
    if (peers.length === 0) return active_only ? 'No other session is running.' : 'There are no other sessions.'
    const max = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
    const lines = peers.slice(0, max).map((peer) => `- ${conversationLabel(peer)} · ${statusText(peer)}`)
    const more = peers.length > max ? `\n… ${peers.length - max} more; raise limit.` : ''
    return `${peers.length} session(s):\n${lines.join('\n')}${more}`
  }
})

export const sendToSessionTool = defineTool<{ session: string; message: string; wait?: boolean }>({
  name: 'send_to_session',
  description:
    'Send a message to another conversation\'s agent (find it with list_sessions). If that session is running, it sees the ' +
    'message after its current step; if it is idle, the message starts a new turn there. With wait=true you get its final ' +
    'reply as this tool\'s result (use it to ask a question or hand over a task and wait for the outcome); with wait=false ' +
    'the message is only delivered. The other agent cannot see this conversation, so make the message self-contained.',
  inputSchema: {
    type: 'object',
    properties: {
      session: { type: 'string', description: 'Session id from list_sessions (the short form is enough).' },
      message: { type: 'string', description: 'The message for the other agent.' },
      wait: { type: 'boolean', description: 'Wait for its reply (default true).' }
    },
    required: ['session', 'message'],
    additionalProperties: false
  },
  permission: 'exec',
  async preview({ session, message, wait = true }, ctx) {
    const peers = await messengerOf(ctx).list().catch(() => [])
    const wanted = session.trim().toLowerCase()
    const peer = peers.find((candidate) => candidate.id.startsWith(wanted))
    const target = peer ? `"${peer.title}" (${shortId(peer.id)})` : session
    const text = message.trim().replace(/\s+/g, ' ')
    const body = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text
    return { summary: `${wait ? 'Ask' : 'Message'} session ${target}: ${body}` }
  },
  async execute({ session, message, wait = true }, ctx) {
    if (!session.trim()) throw new ToolError('session is empty.')
    if (!message.trim()) throw new ToolError('message is empty.')
    return messengerOf(ctx).send({ session: session.trim(), message: message.trim(), wait }, ctx)
  }
})

export const sessionTools = [listSessionsTool, sendToSessionTool]
