# phase-0 spike：自建根 + 官方核心组装

- 日期：2026-10-28
- 环境：macOS arm64、Node v24.18.0、官方 `@deepseek-ai/dsh` 0.2.1-rc.2
- 数据：临时 `$DSH_HOME=/tmp/nano-boot-spike/home`、数据根 `/tmp/nano-boot-spike/data`
- 性质：只读装配探针；未提交产品代码，未用真实模型/凭据

## 结论

自建 Cordis 根 + 官方核心组装**可行**，但正确入口不是 `composeEntries`/`loadProfile` 单独调用，而是：

1. `loadProfileDirectory` 读取应用自持 profile（数据根下的目录，bundle 层 + 用户 patch）；
2. `readProfilePatches` 取 profile patch；
3. 追加运行时 patch：`tool-ask-user`、`file-reference-local`、`terminal-controller`，以及 storage 根；
4. `createRuntimeResolution` 生成模块解析；
5. `boot()` 启动根，注入 `profileContext`、`cmdlineArgs`、`appExit`、`appReady`，并挂 `PluginPackages`；
6. `appReady.commit()`。

## 实测

| 项 | 结果 |
|---|---|
| boot 到核心可用 | 505–826ms（冷/热多次；应用自持 profile 510–531ms） |
| 服务数 | 87 |
| 必需服务 | `agents`、`sessions`、`sessionQuery`、`userQuestions`、`approval`、`terminalController`、`fileReferences`、`sessionPersistence`、`storage`、`jobs`、`skills`、`commands` 全部为真 |
| 工具 | `ask_user_question`、`bash` 均存在 |
| 启动期间 stdout 写入 | 0 次 |
| 首帧（spike 自绘） | 核心就绪后 505–826ms；未做 pre-boot 首帧 |
| storage-json 根 | 写入 `<数据根>/runtime-data/spike-root/storage/session_projcache/sessions/session-1.json` |
| session-persistence 根 | 已 patch 为 `<数据根>/sessions`；空会话 flush 未产生文件 |
| 应用自持 profile | `loadProfileDirectory('nano', <数据根>/profile, anchor)` 成功；profile 写在数据根 |
| `$DSH_HOME` 写入 | 仅 `.anonymous-user-id`；没有 `profiles/`、`storages/`、`sessions/` |
| 会话创建/flush | `ctx.sessions.create({meta:{cwd}})` + `append('turn/start')` + `flush` 成功 |
| 移除三行官方 patch | base-only 时 `ask_user_question`、`terminalController`、`fileReferences` 缺失（上一轮对抗探针） |
| 去掉 `PluginPackages` | 24ms 内失败，93 个插件 bare import `ERR_MODULE_NOT_FOUND`（上一轮对抗探针） |

## 对 spec 的直接修正

1. 组装 API 改写为 `boot` + `PluginPackages` + `profileContext` + `appReady`；`composeEntries`/`loadProfile` 只做 profile 读取/合成，不启动核心。
2. 官方核心需要补 `tool-ask-user`、`file-reference-local`、`terminal-controller` 三行；否则 α 的问卷、S02 的终端与 `@` 文件补全缺服务。
3. storage 根必须显式 patch：`session-persistence-jsonl.root` 与 `storage-json.root` 指向数据根；否则默认写 `$DSH_HOME/sessions`、`$DSH_HOME/storages`。
4. `$DSH_HOME` 仍会写 `.anonymous-user-id`；「$DSH_HOME 不动」需改成「除官方匿名标识外不写」。
5. 首帧若要求先于核心，需要 pre-boot 最小渲染；按实测核心约 0.5–0.8s，不能只靠「核心后再画」。
6. 官方依赖树含 native 预编译包（node-pty / koffi / sharp / node-addon-require-builtin）；「无 native」只能表述为「nano 自身不新增原生 addon」。
7. `dsh --profile` 回退若保留，需要独立的 profile bundle/安装器/终端语义；spike 未验证该路径，建议本次不做回退、phase-0 失败即停下重定方案。

## 未覆盖

- 真实模型一轮对话（临时 home 无凭据）。
- 渲染器/输入/终端独占；本 spike 只验证核心组装、stdout 启动纯净与 storage 根。
- 运行时 stdout/stderr 守护、`uncaughtException` 清理、HMR 关闭、settings/profile 归属。
- 官方 native 预编译包在干净机器上的安装。
