# MR Watch 独立服务化交接

更新时间：2026-11-09

## 实施说明（独立服务版本）

以下为原始交接要求。实施时按用户明确指示作两项调整：默认服务目录使用
`~/.config/mr-watch`，不实现旧 `.mr-watch` 数据迁移、v1 字符串项目或旧配置读取兼容。
验收第 9 项由“旧数据迁移”替换为“确认被管理项目和启动目录中不产生服务数据”。

现已实现 v2 对象项目、零项目启动、CLI / 管理页动态增删、按项目 workspace
创建审查线程、API-only 项目、配置及 Token 变更唤醒、项目级 developer 路由。
使用方法和本地 mock 验证入口见 [README](../README.md)。

## 当前基线

- GitHub：`alanwalk/mr-watch`，`main` 分支
- npm：`@alanwalk/mr-watch@0.1.0`，公开包
- 交接前基线提交：`a4ac136`
- 当前实现可运行，但仍以“在 Git 仓库目录启动”为中心，这是下一阶段需要修改的核心问题。

## 目标

把 `mr-watch` 定义为独立本地服务，而不是某个项目的附属脚本。

- 服务可以从任意目录启动，不要求当前目录属于 Git 仓库。
- 服务数据使用固定服务目录，不写入用户项目仓库。
- 启动时项目数量可以为 `0`。
- 项目在服务运行期间通过配置、CLI 或管理页动态增加和删除。
- 每个项目可以配置独立的本地仓库目录；项目也可以只配置 GitLab project path，暂不提供本地仓库。
- GitLab host 是服务级配置，不再从启动目录的 `origin` 隐式推断。
- review thread 的 `cwd` 必须来自项目配置，不能来自进程启动目录。

## 当前实现中的阻塞点

### 服务数据位置

- `src/workspace.mjs` 仍以 Git 仓库根目录作为参数。
- `resolveWorkspaceRoot()` 会从启动目录向上查找 `.git`，找不到就退出。
- `getDataDir()` 返回 `<repo>/.mr-watch`。
- 配置、agent、Token、状态和事件全部写入这个项目仓库目录。

### 项目模型

- `config.projects` 仍然只是字符串数组。
- `watch.mjs` 的 `validateConfig()` 拒绝空项目数组。
- 多个项目没有独立本地仓库路径。
- 管理页只展示 `projects[0]`，并把项目数组直接 `join()`。

### GitLab 认证

- `watch.mjs` 启动时调用 `inferGitLabRemote(workspaceRoot)`。
- GitLab host 依赖启动目录的 `origin remote`。
- 没有项目或没有 Git 仓库时，服务无法完整启动。

### App Server 与审查线程

- `createAppServerClient({ url, cwd })` 在客户端对象上保存一个全局 `cwd`。
- `createReviewThread()` 的 `thread/start` 使用这个全局目录。
- 多项目时，其他仓库的审查线程会在错误目录中启动。

### Developer 路由

- `developerThreadId` 是单个全局会话。
- `--notify <iid>` 也只能落到第一个项目。
- agent registry 已经支持 `projects` 过滤，可作为后续项目级路由基础。

## 目标配置模型

建议将配置升级到 `version: 2`：

```json
{
  "version": 2,
  "role": "reviewer",
  "gitlabHost": "https://git.example.com",
  "projects": [
    {
      "path": "team/project-a",
      "workspace": "C:\\Workspace\\project-a"
    },
    {
      "path": "team/project-b",
      "workspace": "C:\\Workspace\\project-b"
    },
    {
      "path": "team/project-c",
      "workspace": null
    }
  ],
  "reviewThreads": {},
  "agents": {},
  "developerThreadId": "",
  "pollIntervalMs": 60000,
  "appServerUrl": "ws://127.0.0.1:18787",
  "dashboardHost": "127.0.0.1",
  "dashboardPort": 8787
}
```

约束：

- `projects` 允许为空数组。
- `path` 必填且唯一，使用 GitLab project full path。
- `workspace` 可选，必须是本地绝对路径。
- 没有 `workspace` 的项目只能使用 GitLab API 审查，不能做本地文件核对。
- `gitlabHost` 未配置时允许启动，但管理页应引导用户配置或通过项目仓库自动补全。

## 服务目录

建议默认值：

```text
~/.mr-watch/
├─ config.json
├─ agents.json
├─ credentials.json
├─ state-reviewer.json
├─ state-developer.json
└─ events.jsonl
```

支持以下覆盖方式，优先级从高到低：

1. CLI `--home <path>`
2. 环境变量 `MR_WATCH_HOME`
3. 默认 `~/.mr-watch`

`--config <path>` 可以继续用于单独覆盖配置文件路径，但其余数据仍应位于服务目录。

## 建议实施顺序

### 1. 服务目录与空项目启动

- 在 `src/workspace.mjs` 增加 `resolveServiceHome()`。
- 删除运行时对 `resolveWorkspaceRoot(process.cwd())` 的依赖。
- `createDefaultConfig()` 默认 `projects: []`、`gitlabHost: ""`。
- `validateConfig()` 允许空项目。
- CLI 的 `start/init/auth/register/list` 全部改用服务目录。
- `watch.mjs` 在无项目、无 host、无认证时仍启动管理页。

### 2. 项目配置与管理

- 新增项目规范化和去重函数：
  - `normalizeProject()`
  - `getProjectPath()`
  - `getProjectWorkspace()`
- 旧字符串项目自动转换为 `{ path, workspace: null }`。
- 增加管理页项目列表和新增/删除项目接口：
  - `GET /api/projects`
  - `POST /api/projects`
  - `DELETE /api/projects?path=...`
- 新增项目时如果没有传入 `path`，可从 `workspace` 的 `origin` 推断。
- 首个有效项目可以补全服务级 `gitlabHost`。

### 3. App Server 按项目创建线程

- 将 `createReviewThread()` 改为接收 `cwd` 参数。
- App Server 进程本身可以从服务目录启动。
- 创建 review thread 时传入该项目的 `workspace`。
- 没有 `workspace` 时使用服务目录作为中性的线程 cwd，并在 prompt 中明确说明只能使用 GitLab API。

### 4. GitLab 客户端

- `createGitLabClient()` 改为使用 `config.gitlabHost`，不再从启动目录推断。
- Token 仍按 host 存在服务目录的 `credentials.json`。
- 无 host 时返回 `null` 或未认证状态，不阻止管理页启动。
- 保留 `glab` fallback 时，其 cwd 也必须来自项目 workspace，而不是进程 cwd。

### 5. Developer 路由

- 保留单个 `developerThreadId` 作为兼容默认值。
- 新模型优先使用 agent registry 的项目级 thread 路由。
- `--notify` 应支持 `project/path!IID`，并保留纯 IID 的单项目兼容模式。
- 多项目下纯 `--mr 22` 必须要求同时指定 `--project`，避免歧义。

### 6. 迁移旧数据

增加一次性迁移命令，例如：

```powershell
npx @alanwalk/mr-watch migrate `
  --from <legacy-repo>/.mr-watch `
  --repo <legacy-repo>
```

迁移要求：

- 保留 `reviewThreads`、agent、状态和事件。
- 保留已有 GitLab Token。
- 将旧项目字符串转换成 `{ path, workspace }`。
- 不删除旧数据，迁移成功后再由用户决定是否清理。

## 验收清单

1. 在非 Git 目录执行 `npx @alanwalk/mr-watch`，服务正常启动。
2. 服务目录不存在时自动创建默认配置。
3. `projects: []` 时管理页可用，状态显示“暂无项目”。
4. 管理页添加两个不同 workspace 的项目。
5. 两个项目都能独立轮询，单项目 API 失败不会阻断另一个项目。
6. 两个项目创建的 review thread 分别使用各自 workspace。
7. 添加无 workspace 的项目时，可完成 API-only 审查流程。
8. Token 认证后立即触发首轮轮询。
9. 旧 `.mr-watch` 迁移后，已有映射和 agent 仍可用。
10. `npm run check`、`npm pack --dry-run` 和本地 mock GitLab 测试通过。

## 交接注意

- 不要把服务数据重新写回项目仓库。
- 不要用 `process.cwd()` 作为 review thread 的默认项目目录。
- 不要把 `projects[0]` 当作全局项目。
- 修改配置结构时保留旧格式读取兼容，避免已有用户升级后丢失映射。
- `mr-watch` 自己的仓库和本地被管理项目必须保持解耦。
