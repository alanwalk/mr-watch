# @alanwalk/mr-watch

独立运行的本地 GitLab MR 监听服务。定时读取 open MR，为每个 MR 创建审查线程，并在状态变化时通知对应的 Codex 会话或 HTTP hook。

## 启动与服务目录

```powershell
npx @alanwalk/mr-watch
```

可以从任意目录启动，不要求启动目录是 Git 仓库。首次运行自动创建配置，默认角色为 `reviewer`；零项目、未配置 GitLab 地址或未认证时，管理页仍然可用。打开 `http://127.0.0.1:8787`，在「项目管理」中添加项目，在「接入设置」中配置 GitLab 地址和 Token。

数据目录的优先级为：

1. `--home <path>`
2. 环境变量 `MR_WATCH_HOME`
3. `~/.config/mr-watch`

```text
~/.config/mr-watch/
├─ config.json
├─ agents.json
├─ credentials.json
├─ state-reviewer.json
├─ state-developer.json
└─ events.jsonl
```

`--config <path>` 仅覆盖配置文件的位置，其余数据仍位于服务目录。服务不会在被管理的项目中创建 `.mr-watch`。不提供旧 `.mr-watch` 数据迁移或 v1 配置读取兼容。

```powershell
npx @alanwalk/mr-watch init --home C:\Services\mr-watch
npx @alanwalk/mr-watch start --home C:\Services\mr-watch --role reviewer
```

## 动态管理项目

管理页和 CLI 均支持在运行期间增删项目，也可以直接编辑 `config.json` 的 `projects` 数组。项目及 Token 文件变更会唤醒轮询，无需重启服务。删除项目停止后续轮询；历史状态、事件和线程映射保留，管理页的活跃列表只显示已配置项目。

```powershell
# 通过本地仓库的 origin 推断项目路径；服务未配置 host 时同时补全 host
npx @alanwalk/mr-watch project add --workspace C:\Workspace\project-a

# 显式指定项目和本地绝对路径
npx @alanwalk/mr-watch project add --project team/project-b --workspace C:\Workspace\project-b

# 无本地仓库，只通过 GitLab API 审查
npx @alanwalk/mr-watch project add --project team/project-c --host https://git.example.com

npx @alanwalk/mr-watch project list
npx @alanwalk/mr-watch project remove --project team/project-b
```

`workspace` 必须是运行服务的机器上的绝对路径。`path` 必填且唯一；通过 workspace 添加时可从 HTTPS、`ssh://` 或 `git@host:group/project.git` 形式的 origin 推断。一个服务使用一个 `gitlabHost`，添加项目时会检查可解析的 origin host 是否一致。已有项目时切换 host 需要先删除项目。

项目管理 API：

- `GET /api/projects`：返回 `{ projects, gitlabHost }`。
- `POST /api/projects`：接收 `{ path, workspace }`，两者至少提供一项，成功返回 201 和管理页概览。
- `DELETE /api/projects?path=team%2Fproject`：删除项目，返回管理页概览。

每个项目独立处理，单项目 API 或线程创建失败会记录错误并继续处理其他项目。

## GitLab 认证

GitLab host 是服务配置，不从进程启动目录推断。管理页可填写 host、打开对应的 Token 创建页，并保存具有 `read_api` 权限的 Personal Access Token。保存前调用 `/api/v4/user` 验证，认证成功后立即开始检查。

```powershell
Get-Content .\gitlab-token.txt | npx @alanwalk/mr-watch auth --host https://git.example.com --token-stdin
```

Token 按 host 存入服务目录的 `credentials.json`，页面不会回显。`GITLAB_TOKEN` 环境变量优先于保存的 Token；环境变量发生变更需要重启服务。没有 Token 时，仅配置了 workspace 的项目可回退到本机 `glab` 登录态；所有 `glab` 调用都使用该项目的 workspace 和服务配置的 host。API-only 项目需要 Token。

## 配置 v2

```json
{
  "version": 2,
  "role": "reviewer",
  "gitlabHost": "https://git.example.com",
  "projects": [
    { "path": "team/project-a", "workspace": "C:\\Workspace\\project-a" },
    { "path": "team/project-b", "workspace": null }
  ],
  "reviewThreads": {},
  "developerThreadId": "",
  "developer": { "watchMergeRequests": [] },
  "pollIntervalMs": 60000,
  "appServerUrl": "ws://127.0.0.1:18787",
  "dashboardHost": "127.0.0.1",
  "dashboardPort": 8787
}
```

`projects: []` 和 `gitlabHost: ""` 都是有效配置。管理页监听地址、端口和运行角色在启动时确定；更改这些配置后重启服务。

常用启动参数：

```text
--home <path>
--config <path>
--role reviewer|developer
--project <path>          仅轮询指定的已配置项目，可重复或逗号分隔
--thread <uuid>           developer 默认目标会话
--notify <project!iid>    手动通知，也支持 --mr
--interval <ms>           最小 10000，默认 60000
--app-server-url <url>    默认 ws://127.0.0.1:18787
--review-model <model>
--review-effort <effort>
--dashboard-port <port>   默认 8787
--dashboard-host <host>   默认 127.0.0.1
--no-dashboard
--once
--dry-run
```

## 注册 Agent 与 Developer 路由

```powershell
npx @alanwalk/mr-watch register --thread <thread-uuid> --role developer --project team/project-a --mr 22
npx @alanwalk/mr-watch register --hook-url http://127.0.0.1:9100/mr-watch --project team/project-b
npx @alanwalk/mr-watch list --json
npx @alanwalk/mr-watch unregister --id <agent-id>
```

`--project` 和 `--mr` 支持重复或逗号分隔。省略 `--project` 时注册到当前配置的项目；零项目时匹配全部项目。省略 `--mr` 时匹配全部 MR。多项目或零项目时使用 `--mr` 必须显式指定 `--project`。

- `reviewer`：发现新 MR 时创建审查线程，状态变化时通知审查线程及匹配的注册 agent。
- `developer`：监听当前用户创建的 MR，或 `developer.watchMergeRequests` 指定的 IID。优先通知匹配项目和 MR 的 developer agent；没有匹配 agent 时使用 `--thread` 或 `developerThreadId` 默认会话。没有路由时记录错误，允许服务继续运行。

```powershell
npx @alanwalk/mr-watch --role developer
npx @alanwalk/mr-watch --notify team/project-a!22
npx @alanwalk/mr-watch --project team/project-a --mr 22
```

纯 `--notify 22` / `--mr 22` 仅在单项目时可用，多项目时必须同时指定一个 `--project` 或使用 `project/path!IID`。

## 审查线程

审核端通过 Codex App Server 创建线程，App Server 在需要时连接或尝试从服务目录启动。每个 `thread/start` 显式传入该项目的 workspace，不使用启动 cwd。没有 workspace 的项目使用服务目录作为中性 cwd，提示词明确限定只能使用 GitLab API，不能进行本地项目文件核对。线程映射保存在服务配置中。

管理页默认仅监听 `127.0.0.1`，请勿直接暴露到公网。审查线程采用只读 sandbox，不自动提交、推送、合并或发布 MR 评论。

## 开发验证

```sh
npm run check
npm test
npm pack --dry-run
```

测试使用本地 mock GitLab 和 App Server，覆盖非 Git cwd、服务目录优先级、零项目启动、项目增删、认证唤醒、多项目隔离、线程 cwd、API-only 提示词、配置并发写入、developer 路由和 glab 的项目目录。
