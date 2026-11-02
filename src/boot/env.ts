/**
 * 进程级 NODE_ENV 默认值（issue #138）。
 *
 * `react` 与 `react-reconciler` 都按 `NODE_ENV` 选构建（见
 * `node_modules/react-reconciler/index.js`）。开发构建会给每次组件渲染打一条
 * `performance.measure`，实测 200 次更新产生 8400 条；TUI 一秒几十帧，
 * 条目只增不减，一小时就是上百万条、堆到 GB 级，最后 V8 直接 abort。
 *
 * nano 是 CLI 而不是库：默认按生产构建跑。想看 React 的开发警告时显式
 * `NODE_ENV=development nano`；测试环境（`test`）保持原样，不动。
 */

/** 只决定「没设时该设成什么」，不产生副作用，便于单测。 */
export function launchNodeEnv(current: string | undefined): string {
  return current === undefined || current === '' ? 'production' : current
}

process.env.NODE_ENV = launchNodeEnv(process.env.NODE_ENV)
