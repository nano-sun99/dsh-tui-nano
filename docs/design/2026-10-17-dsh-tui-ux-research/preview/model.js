// Offline /model interaction specimen. It only changes local demo state.
(() => {
  'use strict'

  const four = [
    { id: 'low', name: 'Low', glyph: '○' },
    { id: 'high', name: 'High', glyph: '◐' },
    { id: 'xhigh', name: 'XHigh', glyph: '●' },
    { id: 'max', name: 'Max', glyph: '◉' },
  ]

  class ModelPreview {
    constructor({ host, cells, onChange }) {
      this.host = host
      this.cells = cells
      this.onChange = onChange
      this.key = null
      this.pending = false
      this.result = null
      this.modelIndex = 0
      // 0 = 「默认」：不发送 reasoningEffort；1..n 对应官方档位顺序。
      this.effortIndex = 0
      this.models = [
        { name: 'DeepSeek-V4.1-Flash', current: true, levels: four, defaultEffort: 'High' },
        { name: 'DeepSeek-V4-Pro', current: false, levels: four.slice(0, 2), defaultEffort: 'Low' },
        { name: 'DeepSeek-Chat', current: false, levels: [], defaultEffort: null },
      ]
      host.addEventListener('click', event => this.click(event))
    }

    hide() {
      this.host.classList.remove('model-host')
      this.key = null
      this.pending = false
      this.result = null
      this.host.hidden = true
      this.host.innerHTML = ''
    }

    show(key) {
      if (this.key === key) {
        this.paint()
        return
      }
      this.key = key
      this.host.classList.add('model-host')
      this.pending = true
      this.result = null
      this.modelIndex = 0
      this.effortIndex = 0
      this.paint()
      this.focusPanel()
    }

    focusPanel() {
      this.host.querySelector('.model-panel')?.focus({ preventScroll: true })
    }

    currentModel() {
      return this.models[this.modelIndex]
    }

    currentLevels() {
      return this.currentModel().levels
    }

    currentEffort() {
      if (this.effortIndex === 0) return null
      return this.currentLevels()[this.effortIndex - 1] ?? null
    }

    effortLabel() {
      const effort = this.currentEffort()
      if (effort) return effort.name
      const model = this.currentModel()
      if (model.levels.length === 0) return '不可调'
      return model.defaultEffort ? `默认（模型默认：${model.defaultEffort}）` : '默认'
    }

    finish(result) {
      this.pending = false
      this.result = result
      this.host.classList.remove('model-host')
      this.host.hidden = true
      this.host.innerHTML = ''
      this.onChange(this)
    }

    moveModel(delta) {
      this.modelIndex = Math.max(0, Math.min(this.models.length - 1, this.modelIndex + delta))
      this.effortIndex = 0
      this.paint()
      this.focusPanel()
    }

    moveEffort(delta) {
      const count = this.currentLevels().length + 1
      if (count <= 1) return
      this.effortIndex = (this.effortIndex + delta + count) % count
      this.paint()
      this.focusPanel()
    }

    click(event) {
      if (!this.pending) return
      const model = event.target.closest('[data-model-index]')
      if (model) {
        this.modelIndex = Number(model.dataset.modelIndex)
        this.effortIndex = 0
        this.paint()
        this.focusPanel()
        return
      }
      const effort = event.target.closest('[data-effort-index]')
      if (effort) {
        this.effortIndex = Number(effort.dataset.effortIndex) + 1
        this.paint()
        this.focusPanel()
      }
    }

    handleKey(event) {
      if (!this.pending) return false
      if (event.key === 'Escape') {
        event.preventDefault()
        this.finish({ kind: 'cancelled' })
        return true
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        this.moveModel(event.key === 'ArrowUp' ? -1 : 1)
        return true
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        this.moveEffort(event.key === 'ArrowLeft' ? -1 : 1)
        return true
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        this.finish({
          kind: 'selected',
          model: this.currentModel().name,
          effort: this.currentEffort()?.name ?? '默认',
        })
        return true
      }
      return true
    }

    paint() {
      this.host.hidden = false
      if (this.result) {
        const text = this.result.kind === 'cancelled'
          ? '已取消，模型与强度未提交。'
          : `已选择 ${this.result.model} · ${this.result.effort}。`
        this.host.innerHTML = `<div class="choice-receipt muted">${this.cells(text)}</div>`
        this.onChange(this)
        return
      }

      const model = this.currentModel()
      const levels = model.levels
      const effort = this.currentEffort()
      const rows = this.models.map((item, index) => `<div class="model-row${index === this.modelIndex ? ' focused' : ''}" data-model-index="${index}" role="option" aria-selected="${index === this.modelIndex}">
        <span class="model-pointer">${index === this.modelIndex ? '▶' : ' '}</span><span class="model-name">${this.cells(item.name)}</span>
      </div>`).join('')

      let effortArea
      if (levels.length === 0) {
        effortArea = `<div class="model-effort"><div class="muted">${this.cells('强度：该模型未声明（不可调）')}</div></div>`
      } else {
        const percent = this.effortIndex === 0
          ? 0
          : levels.length === 1
            ? 100
            : ((this.effortIndex - 1) / (levels.length - 1)) * 100
        const labels = levels.map((level, index) => {
          const left = levels.length === 1 ? 50 : (index / (levels.length - 1)) * 100
          const transform = levels.length === 1 ? ';transform:translateX(-50%)' : ''
          return `<span class="${this.effortIndex === index + 1 ? 'active ' : ''}${level.id}" data-effort-index="${index}" style="left:${left}%${transform}">${this.cells(level.name)}</span>`
        }).join('')
        effortArea = `<div class="model-effort">
          <div class="model-effort-bar" data-level="${effort ? effort.id : 'default'}" style="--effort-percent:${percent}%"><div class="model-effort-fill"></div></div>
          <div class="model-effort-labels">${labels}</div>
        </div>`
      }

      this.host.innerHTML = `<section class="model-panel" tabindex="0" aria-label="模型选择">
        <div class="model-head"><strong>${this.cells('模型')}</strong><span>${this.cells(`当前：${model.name} · ${this.effortLabel()}`)}</span></div>
        <div class="model-list">${rows}</div>
        ${effortArea}
      </section>`
      this.focusPanel()
      this.onChange(this)
    }

    snapshot() {
      return {
        kind: 'model',
        pending: this.pending,
        model: this.currentModel().name,
        effort: this.currentEffort()?.name ?? '默认',
        label: this.effortLabel(),
        levels: this.currentLevels().map(level => level.name),
        result: this.result,
      }
    }
  }

  window.TuiModelPreview = ModelPreview
})()
