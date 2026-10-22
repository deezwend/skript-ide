/** Sağlayıcıdan bağımsız konuşma biçimi. Her provider adaptörü kendi API biçimine bundan çevirir. */

export interface TextBlock {
  type: 'text'
  text: string
}

/** Kullanıcının eklediği görsel; base64 kodlu, `data:` öneki olmadan. */
export interface ImageBlock {
  type: 'image'
  mediaType: ImageMediaType
  data: string
}

/** Tüm sağlayıcıların ortak kabul ettiği görsel türleri. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

export function isImageMediaType(value: unknown): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly unknown[]).includes(value)
}

export function imageDataUrl(block: ImageBlock): string {
  return `data:${block.mediaType};base64,${block.data}`
}

/** Bir mesajdaki en fazla görsel. */
export const MAX_IMAGES_PER_MESSAGE = 10
/** Görselin base64 uzunluğu; Anthropic 5 MB'ı aşanı reddeder. */
export const MAX_IMAGE_BASE64_LENGTH = 5 * 1024 * 1024

/** Arayüzden gelen görselleri doğrular; geçersiz biçim ya da sınır aşımında hata atar. */
export function parseImageInput(raw: unknown): ImageBlock[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('Görseller liste olmalı.')
  if (raw.length > MAX_IMAGES_PER_MESSAGE) throw new Error(`Bir mesaja en fazla ${MAX_IMAGES_PER_MESSAGE} görsel eklenebilir.`)
  return raw.map((item): ImageBlock => {
    const { mediaType, data } = (item ?? {}) as { mediaType?: unknown; data?: unknown }
    if (!isImageMediaType(mediaType)) throw new Error('Desteklenmeyen görsel türü (PNG, JPEG, GIF ya da WebP olmalı).')
    if (typeof data !== 'string' || data === '' || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new Error('Görsel verisi bozuk.')
    if (data.length > MAX_IMAGE_BASE64_LENGTH) throw new Error('Görsel çok büyük (en fazla 5 MB).')
    return { type: 'image', mediaType, data }
  })
}

export interface ToolCallBlock {
  type: 'tool_call'
  /** Sağlayıcının verdiği kimlik; sonuç bu kimlikle eşlenir. */
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: 'tool_result'
  callId: string
  content: string
  isError?: boolean
  /** Tool proje dosyalarını değiştirdiyse eklenen/silinen satır sayısı; yalnızca arayüz içindir, modele gitmez. */
  diff?: { added: number; removed: number }
}

/**
 * Sağlayıcıya özgü, bizim yorumlamadığımız blok (örn. Anthropic'in `thinking` blokları).
 * Aynı sağlayıcıya sonraki isteklerde aynen geri gönderilmeli; diğer sağlayıcılar yok sayar.
 */
export interface ProviderDataBlock {
  type: 'provider_data'
  /** Bloğu üreten katalog sağlayıcısı (`anthropic`, `minimax`…). */
  provider: string
  data: unknown
}

/**
 * Modelin düşünme (reasoning) metni; OpenAI uyumlu sağlayıcıların `reasoning_content` / `reasoning`
 * alanından gelir. Arayüzde gösterilir; yalnızca aynı sağlayıcıya ve aynı tur içinde geri gönderilir.
 */
export interface ReasoningBlock {
  type: 'reasoning'
  provider: string
  text: string
  /** Sağlayıcının kullandığı alan adı; geri gönderirken aynısı kullanılır. */
  field: 'reasoning_content' | 'reasoning'
}

export type ContentBlock = TextBlock | ImageBlock | ToolCallBlock | ToolResultBlock | ProviderDataBlock | ReasoningBlock

export interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

export function textMessage(role: Message['role'], text: string): Message {
  return { role, content: [{ type: 'text', text }] }
}

export function toolCalls(message: Message): ToolCallBlock[] {
  return message.content.filter((block): block is ToolCallBlock => block.type === 'tool_call')
}
