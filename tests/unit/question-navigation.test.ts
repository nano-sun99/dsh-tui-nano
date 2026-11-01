import { describe, expect, it } from 'vitest'
import { DecisionManager } from '../../src/decisions/manager.ts'
import { InputParser } from '../../src/input/parser.ts'

const questions = [
  { id: 'q1', question: '怎么验？', options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'q2', question: '测哪里？', multiSelect: true, options: [{ label: 'C' }, { label: 'D' }] },
]

describe('question navigation and validation', () => {
  it('decodes the terminal Shift+Tab sequence as reverse navigation', () => {
    expect(new InputParser().feed('\x1b[Z')).toMatchObject([
      { type: 'key', key: { name: 'tab', shift: true } },
    ])
  })
  it('restores each question focus, including the custom editor', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion(questions)
    manager.move(1)
    manager.selectIndex(1)
    manager.move(-1)
    manager.typeCustom('自己的范围')
    manager.navigateQuestions(-1)
    expect(manager.prompt).toMatchObject({ current: 0, focusedOption: 1 })
    manager.navigateQuestions(1)
    expect(manager.prompt).toMatchObject({ current: 1, focusedOption: 2 })
    manager.confirmFocused()
    manager.submitQuestions()
    await expect(pending).resolves.toEqual({
      answers: [
        { id: 'q1', selected: ['B'] },
        { id: 'q2', selected: [], custom: '自己的范围' },
      ],
    })
  })

  it('uses the submission error and focuses the first option of the first missing question', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion(questions)
    manager.move(1)
    manager.navigateQuestions(-1)
    manager.submitQuestions()
    expect(manager.prompt).toMatchObject({
      current: 0,
      focusedOption: 0,
      error: '请先回答这一题。',
    })
    manager.skipQuestion()
    manager.skipQuestion()
    manager.submitQuestions()
    await expect(pending).resolves.toEqual({
      answers: [
        { id: 'q1', selected: [] },
        { id: 'q2', selected: [] },
      ],
    })
  })

  it('accepts a multi-select custom answer after returning to the options', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion([questions[1]!])
    manager.move(-1)
    manager.typeCustom('自定义')
    manager.move(1)
    manager.confirmFocused()
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q2', selected: [], custom: '自定义' }],
    })
  })

  it('clears deliberate skip when an option is changed and prevents an empty replacement', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion(questions)
    manager.skipQuestion()
    manager.skipQuestion()
    manager.focusQuestion(1)
    manager.selectIndex(0)
    manager.selectIndex(0)
    manager.focusQuestion(2)
    manager.submitQuestions()
    expect(manager.prompt).toMatchObject({ current: 1, error: '请先回答这一题。' })
    manager.skipQuestion()
    manager.submitQuestions()
    await expect(pending).resolves.toHaveProperty('answers')
  })

  it('resets focus on validation and clears the error on a valid edit', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion([
      { id: 'q', question: '选？', options: [{ label: 'A' }] },
    ])
    manager.move(-1)
    manager.confirmFocused()
    expect(manager.prompt).toMatchObject({
      focusedOption: 0,
      error: '请填写其他答案，或选择一个选项。',
    })
    manager.move(-1)
    manager.typeCustom('确认')
    expect(manager.prompt).not.toHaveProperty('error', '请填写其他答案，或选择一个选项。')
    manager.confirmFocused()
    await expect(pending).resolves.toHaveProperty('answers')
  })

  it('rejects an already-aborted request without opening a card', async () => {
    const manager = new DecisionManager()
    const signal = AbortSignal.abort()
    const pending = manager.askQuestions({ questions, signal })
    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    expect(manager.prompt).toBeUndefined()
  })
})
