// 本地 mock 模型（Anthropic Messages SSE），给主链路 e2e 用：
// 不发真实请求、不需要真实凭据。监听随机端口，把端口打到 stdout（LISTENING <port>）。
//
// MOCK_SCRIPT=edit     ：read note.txt → edit old→new → 完成文本
// MOCK_SCRIPT=approval ：bash 请求 danger-full-access（触发审批卡）→ 完成文本
import { createServer } from 'node:http'

const mode = process.env.MOCK_SCRIPT ?? 'edit'
let step = 0

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
    sse(res)
    start(res, body.model)
    if (!withTools) {
      // 标题/摘要之类的非 agent 请求：给一段短文本，不要发工具调用。
      text(res, 'mock title')
    } else if (mode === 'approval') {
      if (step === 0) {
        step += 1
        toolUse(res, 'toolu_approval', 'bash', {
          command: 'touch approval-ok.txt',
          description: 'Create approval marker',
          sandbox_permissions: 'danger-full-access',
          justification: '验证审批卡片与允许一次',
        })
      } else {
        text(res, '主链路完成：审批已通过。')
      }
    } else if (step === 0) {
      step += 1
      toolUse(res, 'toolu_read', 'read', { file_path: 'note.txt' })
    } else if (step === 1) {
      step += 1
      toolUse(res, 'toolu_edit', 'edit', {
        file_path: 'note.txt',
        old_string: 'old line',
        new_string: 'new line',
      })
    } else {
      text(res, '主链路完成：文件已改。')
    }
    send(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
}

const server = createServer(handler)
server.listen(0, '127.0.0.1', () => {
  console.log(`LISTENING ${server.address().port}`)
})
