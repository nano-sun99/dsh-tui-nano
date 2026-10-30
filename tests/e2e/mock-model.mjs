// 本地 mock 模型（Anthropic Messages SSE），给主链路 e2e 用：
// 不发真实请求、不需要真实凭据。监听随机端口，把端口打到 stdout（LISTENING <port>）。
//
// MOCK_SCRIPT=chain    ：read → edit(old→new) → bash 提权（审批）→ 最终文本
// MOCK_SCRIPT=approval ：bash 提权（审批）→ 最终文本
//
// 最终文本按最后一个 tool_result 的 is_error 决定：失败就绝不回「已完成」。
import { createServer } from 'node:http'

const mode = process.env.MOCK_SCRIPT ?? 'chain'
const LONG_TEXT =
  '这是一段用于真实 Ghostty 视觉验收的中文长文本，检查 CJK 宽度、换行与阅读层级。nano 不铺整屏实色，普通背景保留终端默认背景；diff、选择与 hover 才用自有 RGB。\n\n' +
  Array.from(
    { length: 10 },
    (_, index) => `第 ${String(index + 1).padStart(2, '0')} 行：主题、间距与窄屏换行检查。`,
  ).join('\n')

const sse = (res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
}

const send = (res, event, data) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const start = (res, model) => {
  send(res, 'message_start', {
    type: 'message_start',
    message: {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: model ?? 'mock',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  })
}

const text = (res, value) => {
  send(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })
  send(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: value },
  })
  send(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  send(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 8 },
  })
}

const toolUse = (res, id, name, input) => {
  send(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id, name, input: {} },
  })
  send(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
  })
  send(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  send(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 5 },
  })
}

/** 收集请求里已出现的 tool_result 块（按出现顺序）。 */
function collectToolResults(messages) {
  const results = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) {
      if (block?.type === 'tool_result') results.push(block)
    }
  }
  return results
}

const handler = (req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      // 非 JSON 请求按空体处理；下面会走文本分支。
    }
    const withTools = Array.isArray(body.tools) && body.tools.length > 0
    if (mode === 'text') {
      sse(res)
      start(res, body.model)
      text(res, LONG_TEXT)
      send(res, 'message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    if (mode === 'slow') {
      sse(res)
      res.on('error', () => {})
      start(res, body.model)
      setTimeout(() => {
        try {
          text(res, LONG_TEXT)
          send(res, 'message_stop', { type: 'message_stop' })
          res.end()
        } catch {
          // 客户端已退出：不再写。
        }
      }, 4000)
      return
    }
    if (mode === 'monitor' && withTools) {
      sse(res)
      start(res, body.model)
      if (collectToolResults(body.messages).length === 0) {
        toolUse(res, 'toolu_monitor', 'bash', {
          command: 'sleep 30',
          description: 'MONITOR_MARKER job',
          run_in_background: true,
          sandbox_permissions: 'danger-full-access',
          justification: '验证 Monitor 跨会话隔离',
        })
      } else {
        text(res, 'MONITOR_STARTED')
      }
      send(res, 'message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    if (mode === 'subagent' && withTools) {
      const childPrompt = '子任务：核对配置依赖。'
      const messages = Array.isArray(body.messages) ? body.messages : []
      const isChild = messages.some(
        (message) =>
          message?.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) => block?.type === 'text' && String(block.text ?? '').includes(childPrompt),
          ),
      )
      const results = collectToolResults(messages)
      sse(res)
      start(res, body.model)
      if (isChild) {
        text(res, '子任务完成：已核对配置依赖。')
      } else if (results.length === 0) {
        toolUse(res, 'toolu_subagent', 'subagent', {
          description: '查找配置依赖',
          prompt: childPrompt,
        })
      } else {
        text(res, '父任务完成：子任务已分派。')
      }
      send(res, 'message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    if (mode === 'question' && withTools) {
      sse(res)
      start(res, body.model)
      toolUse(res, 'toolu_question', 'ask_user_question', {
        questions: [
          {
            id: 'q1',
            header: '跨会话问题',
            question: 'QUESTION_MARKER：只应出现在发起会话',
            options: [{ label: '继续' }],
          },
        ],
      })
      send(res, 'message_stop', { type: 'message_stop' })
      res.end()
      return
    }
    const results = collectToolResults(body.messages)
    const failed = results.some((result) => result.is_error === true)
    sse(res)
    start(res, body.model)
    if (!withTools) {
      // 标题/摘要之类的非 agent 请求：给一段短文本，不要发工具调用。
      text(res, 'mock title')
    } else if (mode === 'approval') {
      if (results.length === 0) {
        toolUse(res, 'toolu_approval', 'bash', {
          command: 'touch approval-ok.txt',
          description: 'Create approval marker',
          sandbox_permissions: 'danger-full-access',
          justification: '验证审批卡片与允许一次',
        })
      } else {
        text(res, failed ? '主链路结束：审批被拒绝或命令失败。' : '主链路完成：审批已通过。')
      }
    } else if (results.length === 0) {
      toolUse(res, 'toolu_read', 'read', { file_path: 'note.txt' })
    } else if (results.length === 1) {
      toolUse(res, 'toolu_edit', 'edit', {
        file_path: 'note.txt',
        old_string: 'old line',
        new_string: 'new line',
      })
    } else if (results.length === 2) {
      toolUse(res, 'toolu_approval', 'bash', {
        command: 'touch approval-ok.txt',
        description: 'Create approval marker',
        sandbox_permissions: 'danger-full-access',
        justification: '验证审批卡片与允许一次',
      })
    } else {
      text(
        res,
        failed ? '主链路结束：审批被拒绝或命令失败。' : '主链路完成：文件已改、审批已通过。',
      )
    }
    send(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
}

const server = createServer(handler)
server.listen(0, '127.0.0.1', () => {
  console.log(`LISTENING ${server.address().port}`)
})
