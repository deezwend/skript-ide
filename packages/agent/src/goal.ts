/**
 * `/goal` ile verilen konuşma hedefi. Sistem istemine yazılmaz: değişen sistem istemi önbelleği baştan
 * geçersiz kılar. Hedef değiştiğinde bir sonraki kullanıcı mesajına ayrı bir metin bloğu olarak eklenir;
 * böylece geçmişe yalnızca ekleme yapılır ve önceki önek önbellekte kalır. Saf modül; arayüz de kullanır.
 */
import type { Message } from './messages'

const GOAL = /^<conversation_goal>\n([\s\S]*)\n<\/conversation_goal>$/
const GOAL_CLEARED = '<conversation_goal_cleared />'

/** Sistem isteminde sabit kalan açıklama; blokların ne anlama geldiğini modele söyler. */
export const GOAL_INSTRUCTIONS =
  'The user may set a goal for the conversation; it arrives as a <conversation_goal> block in their message. ' +
  'Keep working toward the most recent goal across messages, and say clearly when it is done or what blocks it. ' +
  `${GOAL_CLEARED} means the goal was removed.`

/** Hedefin modele giden metni; `null`: hedef kaldırıldı. */
export function goalText(goal: string | null): string {
  return goal === null ? GOAL_CLEARED : `<conversation_goal>\n${goal}\n</conversation_goal>`
}

/** Metin bloğu bir hedef bloğuysa hedefi (`null`: kaldırıldı) döndürür; değilse `undefined`. */
export function parseGoal(text: string): string | null | undefined {
  if (text === GOAL_CLEARED) return null
  const match = GOAL.exec(text)
  return match ? match[1] : undefined
}

/** Geçmişte modele en son bildirilen hedef; hiç bildirilmediyse ya da kaldırıldıysa `null`. */
export function latestGoal(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j]
      if (block.type !== 'text') continue
      const goal = parseGoal(block.text)
      if (goal !== undefined) return goal
    }
  }
  return null
}

/** Hedef geçmişte bildirilenden farklıysa yeni mesaja eklenecek blok metni; aynıysa `null`. */
export function goalUpdate(messages: readonly Message[], goal: string | null): string | null {
  return latestGoal(messages) === goal ? null : goalText(goal)
}
