# ADR-20261102-production-build-default：nano 默认按生产构建运行，并周期性清空测量缓冲

- 状态：生效中（随实施 PR 合并生效）
- 日期：2026-11-02
- 来源：用户 2026-11-02 原话「这次做 A+B+C D 另开单」；崩溃证据见 [issue #138](https://github.com/nano-sun99/dsh-tui-nano/issues/138)
- 相关：[#138](https://github.com/nano-sun99/dsh-tui-nano/issues/138)、[发布验收](../release/0.2.0/README.md)

## 决定

1. **未设置 `NODE_ENV` 时，nano 启动即设为 `production`**（`src/boot/env.ts`，且必须是 `src/bin.ts` 的第一个 import）。这样 `react` 与 `react-reconciler` 一起解析到生产构建。
2. **开发警告仍可用**：`NODE_ENV=development nano` 保持原有开发构建；测试环境（`test`）不受影响。
3. **渲染循环每 60 帧调用一次 `performance.clearMeasures()`**（`src/render/renderer.ts`），作为「不依赖构建类型」的兜底。
4. **堆看门狗只观测不干预**：每 30 秒检查一次，超过 `NANO_HEAP_WARN_MB`（默认 2048MB）写一行诊断，冷却 5 分钟；不抬堆上限、不主动退出（`src/runtime/heap-watch.ts`）。

## 为什么

- `react-reconciler` 的开发构建给每次组件渲染打一条 `performance.measure`（`node_modules/react-reconciler/cjs/react-reconciler.development.js` 共 8 处调用），生产构建 0 处。Node 的全局测量缓冲只增不减。
- 实测（40 行树、200 次更新）：开发构建新增 **8400 条**、堆 32.6MB；生产构建 **0 条**、堆 17.9MB。按每条约 1.8KB 折算，一小时的高频渲染足以把 4GB 堆填满——与两次崩溃的 `1000001 measure entries` 警告和 `heap out of memory` 对得上。
- 参考实现：Claude Code 把 devtools 导入放在 `NODE_ENV === 'development'` 条件下（`src/ink/reconciler.ts:33`），并在容器环境注入 `--max-old-space-size=8192`（`src/entrypoints/cli.tsx:13`）；本决定取「不发开发构建」这一条，不取抬上限。

## 代价与边界

- 用户默认看不到 React 的开发警告（props 校验、key 提示等）；需要时显式 `NODE_ENV=development`。
- 兜底清理会清掉**整个进程**的 measure 条目，包括第三方库想留的；nano 是 CLI，没有需要长期保留测量数据的消费者。
- 看门狗不解决内存增长，只保证下次真炸时日志里有一行「当时堆多大」；真正的止血靠第 1 条。
- 不改变任何用户可见的界面文案、键位或协议。

## 重开条件

- 上游 `react-reconciler` 在开发构建里去掉逐组件 `measure`，第 1 条的必要性消失。
- Node 给用户态测量缓冲加上限或自动回收，第 3 条可简化。
- 若某天需要把 nano 当库被别的宿主进程加载（而非独占 CLI 进程），第 1 条会污染宿主环境，必须改为在 `Renderer` 内部选择构建。
