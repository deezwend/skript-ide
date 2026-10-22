import test from 'node:test'
import assert from 'node:assert/strict'
import { goalText, goalUpdate, latestGoal, parseGoal } from '../src/goal'
import { textMessage, type Message } from '../src/index'

const withGoal = (goal: string | null): Message => ({
  role: 'user',
  content: [{ type: 'text', text: 'devam' }, { type: 'text', text: goalText(goal) }]
})

test('hedef bloğu yazılıp geri okunur', () => {
  assert.equal(parseGoal(goalText('komutu bitir')), 'komutu bitir')
  assert.equal(parseGoal(goalText('çok\nsatırlı')), 'çok\nsatırlı')
  assert.equal(parseGoal(goalText(null)), null)
  assert.equal(parseGoal('sıradan metin'), undefined)
})

test('geçmişteki en son hedef bulunur', () => {
  assert.equal(latestGoal([]), null)
  assert.equal(latestGoal([withGoal('a'), textMessage('assistant', 'tamam'), textMessage('user', 'devam')]), 'a')
  assert.equal(latestGoal([withGoal('a'), withGoal('b')]), 'b')
  assert.equal(latestGoal([withGoal('a'), withGoal(null)]), null)
  // Asistan metni hedef sayılmaz
  assert.equal(latestGoal([textMessage('assistant', goalText('x'))]), null)
})

test('hedef yalnızca değiştiğinde yeni mesaja eklenir', () => {
  assert.equal(goalUpdate([], null), null)
  assert.equal(goalUpdate([], 'a'), goalText('a'))
  assert.equal(goalUpdate([withGoal('a')], 'a'), null)
  assert.equal(goalUpdate([withGoal('a')], 'b'), goalText('b'))
  assert.equal(goalUpdate([withGoal('a')], null), goalText(null))
  assert.equal(goalUpdate([withGoal(null)], null), null)
})
