# 强度扫光改绑官方倒数第二档 · 补充规格

- 日期：2026-10-26
- 状态：结构已确认；待合并确认；尚未授权实施。
- 用户确认：本会话实测确认真实目录为 `Off / Low / High / Max`；用户拍板“那就倒数第二档更加扫光吧”，即把扫光绑到官方档位里倒数第二档；规格载体选择“新开补充规格（推荐）”。
- 交付边界：本次先交付补充规格，不把方案确认或审核档位当作实施、合并授权。

## 1. 上游与适用关系

- [视觉与交互规格](../2026-10-25-nano-visual-interaction-alignment/README.md)：本规格取代 §3.3 中“官方恰好声明 `low / high / xhigh / max` 时……使用设计稿配色与动效；其他档位集合……四档配色与动效不套用”的效果绑定，以及同节“档位颜色”中“`xhigh` 使用更深蓝并让高光从左向右移动；未匹配 id 使用 muted 前景、无动效”的触发部分。档位位置、标签、默认态、Low / Max 规则不变；§6 中对应的 XHigh 验收项由本规格 §6 取代。
- [输入、预览与排版规格](../2026-10-26-nano-input-preview-rendering/README.md)：本规格取代 §4.4 中“选中官方 `xhigh`”“当前焦点是 XHigh”的触发条件；其周期、渐变、起播与连续帧可见性要求继续生效，由下一份补充规格细化。
- [工具结果判定与 XHigh 扫光纠偏规格](../2026-10-26-nano-outcome-xhigh-correction/README.md)：本规格取代 §4.3、§4.5、§4.6 中把“有效 XHigh”作为扫光主体的表述，以及 §4.6 中“High 不改”在 High 恰好是扫光档时的冲突；§4.1、§4.2、§4.4、§4.7 的 1400ms 周期、渐变、左中右覆盖、无高光空窗、主题与列宽约束全部沿用，只把“XHigh”读作“扫光档”。
- ADR 检索：实际搜索 `docs/decisions/` 中 `xhigh / effort / 强度 / 扫光 / 动效 / model`，未命中相关决定；沿用 [ADR-20261022-independent-tui-theme](../../decisions/2026-10-22-independent-tui-theme.md) 的颜色所有权与透明背景边界，不新增、无取代 ADR。
- 历史规格正文不改；两份历史要求与本补充冲突时，仅上述明确列出的条款以本补充为准。

## 2. 已核实事实与参考

基线为主干提交 `78f24ec`。

### 2.1 真实目录没有 XHigh

- 2026-10-26 用当前构建 `target/debug/nano` 在 PTY 实跑 `/model`（真实 dsh `0.2.1-rc.2`、真实凭据、未发送消息）：模型 `DeepSeek-V4.1-Flash` / `DeepSeek-V4-Pro`，官方档位为 `Off / Low / High / Max`，没有 `XHigh`。
- 官方源码 `@deepseek-ai/dsh-llm-deepseek/lib/index.js:465` 的 `REASONING_EFFORTS` 写死四档 `off / low / high / max`；`deepseek-official` 经 `dsh-llm-deepseek-api-key` 复用同一张表。
- 设计稿 `docs/design/2026-10-17-dsh-tui-ux-research/preview/model.js:8` 的 `xhigh` 是样稿 fixture 自带数据，不是官方模型目录。

### 2.2 当前绑定不可达，效果本身没坏

- `crates/nano-app/src/ui.rs:3491` 的高光条件按 id 匹配 `xhigh`；`:3876` 的 `xhigh_animation_active` 同样只认 `xhigh`；`crates/nano-app/src/app.rs:7890` 用它维护 `xhigh_anim_start`。真实目录永远不匹配，扫光不会启动。
- 效果代码本身可用：证据 `docs/evidence/2026-10-26-nano-outcome-xhigh-correction/19-xhigh-sweep-100-dark.txt` 中高光峰值位置在 1400ms 内按 0 → 17 → 35 → 53 循环；真实运行聚焦 `Max` 时，底色在 rgb(54,95,157) 与 rgb(73,130,214) 间往复，脉冲正常。
- 既有证据已记录真实目录没有 XHigh：`docs/evidence/2026-10-25-nano-visual-interaction-alignment/README.md:6,28`；上一次交付用确定性 fixture 证明扫光，未解决真机可见性。

## 3. 扫光档的绑定规则

1. **扫光档**定义为官方 `efforts` 列表中索引 `len - 2` 的档位（倒数第二档），仅在 `len >= 3` 时成立；`len < 3` 不启用扫光。
2. 有效焦点是扫光档时，强度条填充使用共享 Palette 的 `effort_xhigh` 底色与 `effort_xhigh_highlight` 高光，高光在填充区域从左向右移动；该档原本按 id 分配的颜色（例如 `high` 的灰蓝）在扫光态不再使用。
3. 标签保持当前档位的 accent / bold 语义，不因扫光改变名称、选择结果或官方档位集合，也不加 `Max` 标签的发光脉冲。
4. 周期、起播、可见性、门控与 reduced motion 沿用 [outcome-xhigh 规格 §4](../2026-10-26-nano-outcome-xhigh-correction/README.md)：1400ms 线性循环、与终端列数和轨道宽度无关；从其他状态进入或重新打开并聚焦扫光档时从左侧起播，200ms 内出现可观察高光；一个周期内覆盖填充区左、中、右，不出现超过 200ms 的整条无高光空窗；只在 `/model` 可见、有效焦点是扫光档且未启用 reduced motion 时推进。
5. `Max` 的脉冲仍只按官方 id `max` 触发，节奏与相位规则不变。若官方集合里存在比 `max` 更高的档位，使倒数第二档的 id 恰为 `max`，保留 `Max` 脉冲、不叠加扫光，见 §7。
6. 其他档位按原 id 配色静态显示，不启用扫光；id 为 `xhigh` 但不在倒数第二档位置的集合同样不启用。不新增颜色角色，不改填充比例、默认态与提交参数。
7. `NANO_REDUCED_MOTION=1|true` 时，扫光档保留静态底色、填充比例与标签，禁止高光移动；`Max` 的既有脉冲也按原规则静止。

## 4. 改动面与不做事项

- `crates/nano-app/src/ui.rs`：扫光档判定、相位选择、填充配色与高光渲染；把只服务 `xhigh` 的门控改为“扫光档”语义（内部命名可随之改为 sweep，见 §8）。
- `crates/nano-app/src/app.rs`：动画时钟字段与 tick 门控随语义改名；不改 tick 节奏。
- 测试：新增 `Off / Low / High / Max` 与 `Low / High / XHigh / Max` 两组集合的相位、颜色、门控、reduced motion 覆盖；补两档与 `Max` 边界。
- `scripts/pty-evidence-input-preview.py` 与新的证据目录：优先扩现有入口产出真实目录的连续 ANSI / PTY 帧；fixture 证据继续用于确定性相位与 reduced motion 回归。不新建框架。
- 不改 bridge / protocol、官方 DSH 包、模型目录语义、主题归属、已合并规格正文；不新增状态来源、存储、协议字段或跨事件关联机制；不改 `Max` 的脉冲节奏（含相位）。
- 如最小范围无法满足本规格，先报告实际缺口；不能自行扩大协议、组件职责或新增机制。

## 5. 有限验收

- [ ] 真实目录（`Off / Low / High / Max`）聚焦 `High`：连续帧高光从左向右移动，1400ms 周期与终端列数无关；进入 / 重入时 200ms 内可见，无超过 200ms 的整条无高光空窗。
- [ ] 同一真实目录聚焦 `Max`：脉冲节奏、相位与改动前一致；`Off / Low` 不出现扫光或脉冲。
- [ ] 确定性 fixture `Low / High / XHigh / Max`：`XHigh`（倒数第二档）扫光与此前一致。
- [ ] 两档集合不启用扫光；倒数第二档为 `max` 的集合按 `Max` 脉冲处理、不叠加扫光。
- [ ] 其他档位的配色、标签、填充比例、默认态、提交参数和选择语义不变。
- [ ] reduced motion 下扫光档静止；面板关闭、切换到非扫光档、全屏终端覆盖、定时任务打开时不保持刷新。
- [ ] 100 / 60 列、dark / light 真实目录 PTY / ANSI 连续帧，以及 fixture 单测，覆盖两个完整周期；fixture 明确标为测试目录。
- [ ] 相关 Rust 定向测试及工作区回归通过，`cargo fmt --check`、`git diff --check` 通过；所有证据可定位且无未处理已知阻断。

完成仅指本规格约定功能、正常 / 异常 / 边界 / 回归及证据齐全；不包含上线后观察天数，不自动新开观察单。

## 6. 机制清单

无新增机制。扫光档是现有官方 `efforts` 顺序上的派生谓词，复用现有 tick、相位、Palette 与面板门控；不新增状态来源、存储、协议字段或 UI 系统。

## 7. 自定细节

- `len < 3` 不启用扫光：避免两档集合把扫光落到最低档，且与设计稿“次高档有扫光”的层级语义一致。
- 倒数第二档 id 恰为 `max` 时保留 `Max` 脉冲、不叠加扫光，避免同一档同时承担两种动效。
- 扫光档配色直接复用 `effort_xhigh` / `effort_xhigh_highlight`，不新造颜色；`high` 的灰蓝只在它不是扫光档时使用。
- 内部命名从 xhigh 改为 sweep（如 `xhigh_anim_start` → `sweep_anim_start`、`xhigh_animation_active` → `sweep_animation_active`），只改语义命名，不改变门控条件与 tick 节奏。
- 高光半径、插值与 cell 取整沿用现值（`filled * 0.25`，线性强度），不重新设计。
- 真实目录证据只在 `/model` 面板内采集，不发送消息、不产生模型费用。
- 体量评估与结构选择：单份补充规格、一张执行 issue；结构无实质变化，不拆。
