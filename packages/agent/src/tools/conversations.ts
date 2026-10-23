/** `search_conversations` / `read_conversation`: kayıtlı geçmiş konuşmalarda arama ve okuma. */
import {
  conversationLabel,
  conversationPage,
  conversationTranscript,
  resolveConversation,
  searchConversations
} from '../conversations'
import { defineTool, ToolError, type ConversationArchive, type ToolContext } from '../tool'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 30

function archiveOf(ctx: ToolContext): ConversationArchive {
  if (!ctx.conversations) throw new ToolError('Saved conversations are not available here.')
  return ctx.conversations
}

export const searchConversationsTool = defineTool<{ query?: string; limit?: number }>({
  name: 'search_conversations',
  description:
    'Search the user\'s earlier, saved conversations with you (not the current one). Every word of the query must appear in the ' +
    'conversation; results show the id, date, title, project and matching excerpts. Leave query empty to list the most recent ' +
    'conversations. Open one with read_conversation.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to look for (case-insensitive). Empty lists recent conversations.' },
      limit: { type: 'integer', description: `Maximum results (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).` }
    },
    additionalProperties: false
  },
  permission: 'read',
  async execute({ query = '', limit = DEFAULT_LIMIT }, ctx) {
    const archive = archiveOf(ctx)
    const max = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
    const infos = await archive.list()
    if (infos.length === 0) return 'There are no saved conversations yet.'
    if (!query.trim()) {
      const listed = infos.slice(0, max).map((info) => `- ${conversationLabel(info)}`)
      return `${infos.length} saved conversation(s), most recent first:\n${listed.join('\n')}`
    }
    const entries = []
    for (const info of infos) {
      if (ctx.signal.aborted) throw new ToolError('Cancelled.')
      const found = await archive.read(info.id)
      if (found) entries.push({ info: found.info, transcript: conversationTranscript(found.messages) })
    }
    const matches = searchConversations(entries, query)
    if (matches.length === 0) return `No saved conversation contains all of: ${query.trim()}`
    const lines = matches.slice(0, max).map((match) => {
      const excerpts = match.snippets.map((snippet) => `    ${snippet}`).join('\n')
      return `- ${conversationLabel(match.info)} · ${match.hits} hit(s)${excerpts ? `\n${excerpts}` : ''}`
    })
    const more = matches.length > max ? `\n… ${matches.length - max} more; refine the query or raise limit.` : ''
    return `${matches.length} conversation(s) match:\n${lines.join('\n')}${more}`
  }
})

export const readConversationTool = defineTool<{ id: string; offset?: number }>({
  name: 'read_conversation',
  description:
    'Read an earlier, saved conversation as a transcript (user and assistant messages, tool calls as one line; tool outputs are ' +
    'not included). Long conversations are returned in pages; pass the offset the previous page gives.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Conversation id from search_conversations or an @chat:… tag (the short form is enough).' },
      offset: { type: 'integer', description: 'Character offset to start from (default 0).' }
    },
    required: ['id'],
    additionalProperties: false
  },
  permission: 'read',
  async execute({ id, offset = 0 }, ctx) {
    try {
      const found = await resolveConversation(archiveOf(ctx), id)
      return conversationPage(found.info, found.messages, offset)
    } catch (error) {
      if (error instanceof ToolError) throw error
      throw new ToolError((error as Error).message)
    }
  }
})

export const conversationTools = [searchConversationsTool, readConversationTool]
