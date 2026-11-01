# OMP fork 更新执行 Prompt

把下面这句话发给有本机终端权限的 AI agent 即可：

> 请读取 `/home/host/Projects/omp-quota-fix/UPDATE_PROMPT.md`，按照其中流程，把维护分支合并到最新官方 `upstream/main`，保留额度修复，验证、重新编译，并更新本机正在使用的 omp。

以下内容是完整任务要求，不需要依赖此前聊天记录。

---

## 目标与授权

你是本机 OMP fork 的维护 agent。请实际执行更新，不要只输出操作建议或停在计划阶段。

1. 获取执行时最新的官方 `upstream/main`，合并到本地维护分支。
2. 保留本 fork 的模型额度判断与账号切换修复；若上游已有等价实现，用行为验证后消除重复实现，不要机械叠加旧代码。
3. 完成相关回归、类型检查、编译和运行验证，安装到本机 `~/.local/bin/omp`。
4. 保留可回滚版本，说明实际使用的上游 commit、fork commit、安装版本和验证结果。

本任务允许创建本地维护/合并提交，修复本次合并导致的相关冲突和构建兼容问题，并原子替换上述安装路径。不要扩大到其他供应商的路由重构、另建号池或修改用户研究项目。

## 固定位置

- 本地仓库：`$HOME/Projects/omp-quota-fix`；本机通常是 `/home/host/Projects/omp-quota-fix`。
- 维护分支：`quota-routing`。
- Fork remote：`origin` → `https://github.com/Bowen-0x00/oh-my-pi.git`。
- 官方 remote：`upstream` → `https://github.com/can1357/oh-my-pi.git`。
- 更新入口：仓库根目录执行 `bun run fork:update`。
- 仅构建/安装当前源码：`bun run fork:build`。
- 仅构建不安装：`bun run fork:build --build-only`。
- 脚本：`packages/coding-agent/scripts/fork-build.sh`。
- 维护说明：`packages/coding-agent/DEVELOPMENT.md` 的 “Maintaining the quota-routing fork”。
- 回滚记录：`${XDG_STATE_HOME:-$HOME/.local/state}/omp/fork-builds/build-*/`，内含 `omp.before` 和 `build-info.txt`。

先读取仓库根 `AGENTS.md`，并遵守相关目录规则。命令和文件名若被上游调整，先查找新入口再迁移流程，不能删除验证步骤来绕过失败。

## 必须保持的额度行为

这些是行为契约，不是要求永远保留某个函数名或实现形式：

- Antigravity 的普通 Gemini 与 Argon 专属额度应按服务端实际额度桶区分。套餐可能共享额度；只有明确证据才能采用共享映射，不能凭缺失字段猜测。
- 普通 Gemini 的余额不能掩盖独立 Argon 额度耗尽，也不能解除 Argon 的冷却。
- 同等可用条件下，明确有目标模型实测余额的账号优先于额度未知账号。
- 明确耗尽/封禁的账号不能压过仍未封禁、权限未知的可尝试账号；真实额度耗尽后要切换可用 sibling，并持久化对应额度桶的冷却供其他实例遵守。
- 服务端 roster 明确禁用目标模型的账号，不能从最后回退路径重新入选；权限缺失或查询失败不等于明确禁用。
- 未知额度不能伪造为 0% 或 100%。恢复冷却需要同一个额度桶的新鲜、有限、正余额证据；认证封禁不能被额度报告解除。
- 健康会话保持账号绑定，不因每次请求强制探测全池；不要增加第二套重试层或无限重试。
- 不改变 Codex 等其他供应商已有的账号优先级语义。流式输出已经交付后，不可通过重放整个请求拼接另一账号的输出。

相关实现主要位于 `packages/ai/src/usage/google-antigravity.ts`、`packages/ai/src/auth/{select,health}.ts`、`packages/ai/src/usage.ts`、`packages/catalog/src/compat/rules/runtime/behavior.kdl`。相关回归由构建脚本列出。

## 执行流程

### 1. 确认环境与保护用户改动

- 确认仓库确实存在、当前分支和 remotes 正确，检查工作区、未完成的 merge 以及当前 `omp` 的实际解析路径和版本。
- 先阅读已有变更。不得 `reset --hard`、`clean -fd`、自动 stash、强制切分支或丢弃用户改动。若用户未提交的改动阻止安全合并，先完成可达的调查，再准确说明阻塞。
- 不执行 `omp update`、安装官网二进制或重建整个仓库：那会覆盖 fork 修复。
- 不把旧聊天中的 token 当作可用认证；不得将 token 写入源码、文档、remote URL、脚本、日志或命令行参数。使用本机已有 SSH/Git credential helper。拉取公开上游不需要私有 token。

### 2. 合并执行时的最新上游

在干净的 `quota-routing` 分支执行：

```bash
cd "$HOME/Projects/omp-quota-fix"
bun run fork:update
```

该入口会 fetch 并 merge `upstream/main`，然后验证、构建和安装。记录实际 fetch 到的 SHA；包版本号即使未改变，也要按 commit 判断是否已更新。

脚本不会替你解决真实源码冲突：如有冲突，阅读双方实现，保留上游新功能和上述额度契约。只修改本次维护相关代码，提交解决后的 merge，再执行 `bun run fork:build`。

生成的 `packages/catalog/src/compat/rules.json` 必须由 KDL 重新生成，不能手写或简单选 ours/theirs。脚本会自动处理仅该生成文件冲突的情况。

如果 Git 已完成合并，而后续测试、类型或构建失败，应修复具体原因并重新验证；不要通过删测试、压掉异常、跳过检查或换回旧二进制冒充完成。

### 3. 工具链与验证

- 优先复用本机 `bun`。备用 Bun 位于 `$HOME/.local/share/omp-quota-build/bun-1.4.4/bin/bun`；它只是已安装工具链，未来更新仍须满足上游实际版本要求。
- 优先使用现有构建脚本，避免复制第二套安装逻辑。该脚本会安装锁定依赖、获取与源码包版本一致的 native addon、重新生成规则、运行额度/OAuth 回归及 AI/catalog 类型检查、编译并做 worker 烟测。
- 不得把旧 native addon 改版本标记后混入新版本。如果执行时最新 `main` 所需 addon 尚未发布，应检查官方 native 源码构建路径及本机条件；能构建则完成，确实不可达时保留旧安装并明确阻塞。不能未经同意降级目标为旧 release 后声称已更新到最新。
- 新版修改了受影响的其他模块时补充对应验证；不要仅看到版本输出就宣告成功。

### 4. 安装后的真实检查

- 确认 `command -v omp` 实际指向目标安装，运行 `omp --version` 和 `omp --smoke-test`。
- 对比安装文件与本次构建产物的 SHA-256；检查最新 `build-info.txt` 的源码 commit 与本次构建一致。
- 本任务允许一次最小 Argon 真实请求验证，使用现有合法账号、无工具、无扩展、无保存会话，要求只返回一个固定短字符串。不要恢复或驱动用户的研究会话。
- 为避免探测改变生产账号路由状态，可用 SQLite backup API 创建仅本用户可读的临时 profile，禁止直接复制正在写入的 DB 文件；验证后删除临时凭据副本。绝不输出 access/refresh token 或完整账号清单。
- 若模型服务本身当时不可用，区分“本地构建/安装通过”和“远端推理未通过”，保留原始错误；不能伪造成功或隐瞒失败。
- 不停止现有 omp 进程或后台任务。运行中的旧进程不会自动加载新二进制；交付时提醒正常退出后用 `omp --continue` 恢复。

### 5. 提交与可选远端同步

- 将本次维护产生的相关源码/文档改动提交到本地维护分支，使下一次更新有干净起点。不要夹带凭据、native 二进制、node_modules、dist、用户配置或临时文件。
- 如本机已配置可用 GitHub 认证，可将分支推送到 `origin/quota-routing`；不要 force push，不要创建 issue/PR。没有认证时，本地 merge、构建、安装仍须完成，并报告待推送的本地提交；不要为此重新索要或复用旧聊天 token。

## 完成时报告

只报告有实际证据的结果：

1. 本地仓库路径、维护分支、官方上游 SHA 和最终 fork SHA。
2. 安装前后的版本；若版本号相同，明确源码 commit 是否变化。
3. 是否完整保留额度行为、如何处理了冲突。
4. 实际通过的回归数量、类型检查、worker 烟测和最小真实请求结果。
5. 实际安装路径、构建/安装 SHA-256、回滚目录。
6. 是否已推送；未推送时说明原因。若存在阻塞，明确哪一步未完成、旧安装是否保持可用。

不要用“计划完成”“脚本已写好”代替真正合并、编译和本地安装。
