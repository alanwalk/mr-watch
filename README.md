# @alanwalk/mr-watch

本地 GitLab MR 状态监听器。它定时读取 open MR，在 MR 状态变化时通知已注册的 Codex 会话或 HTTP hook；审核端也可以直接创建审查线程。

## 快速启动

```powershell
npx @alanwalk/mr-watch
```

也可以显式指定工作区：

```powershell
npx @alanwalk/mr-watch start --workspace C:\Workspace\my-project --role reviewer
```

启动后打开 `http://127.0.0.1:8787`。

GitLab 地址和项目路径不需要填写，程序会从工作区的 `git remote get-url origin` 自动解析：

```text
https://git.example.com/team/project.git
  -> host:    https://git.example.com
  -> project: team/project
```

支持 HTTPS、`ssh://` 和 `git@host:group/project.git` 形式的 origin。

## 快速认证

管理页的「接入设置」提供 GitLab 接入按钮：

1. 点击「创建 GitLab Token」，打开当前自建 GitLab 的 Personal Access Token 页面。
2. 创建仅包含 `read_api` 权限的 Token。
3. 将 Token 粘贴回管理页，点击「保存并验证」。
4. 验证通过后保存到 `<workspace>/.mr-watch/credentials.json`，并立即用新 Token 开始检查。

页面不会回显或记录 Token。`GITLAB_TOKEN` 环境变量优先于本地保存的 Token；使用环境变量时，页面会显示该状态并停用 Token 输入。

命令行也可以完成认证：

```powershell
# 从标准输入读取，避免 Token 进入命令历史
Get-Content .\gitlab-token.txt | npx @alanwalk/mr-watch auth --workspace C:\Workspace\my-project --token-stdin

# 直接传参仅建议用于临时调试
npx @alanwalk/mr-watch auth --workspace C:\Workspace\my-project --token glpat-xxxx
```

Token 至少需要 `read_api`。程序通过 GitLab REST API 读取 MR、讨论和 pipeline，不依赖 `glab`；没有 Token 时仍保留 `glab` 兼容回退。

## 注册 Agent

注册 Codex thread：

```powershell
npx @alanwalk/mr-watch register --workspace C:\Workspace\my-project --thread <thread-uuid> --role developer
```

注册 HTTP hook：

```powershell
npx @alanwalk/mr-watch register --workspace C:\Workspace\my-project `
  --hook-url http://127.0.0.1:9100/mr-watch `
  --project team/project `
  --mr 22
```

查看和注销：

```powershell
npx @alanwalk/mr-watch list --workspace C:\Workspace\my-project
npx @alanwalk/mr-watch unregister --workspace C:\Workspace\my-project --id <agent-id>
npx @alanwalk/mr-watch unregister --workspace C:\Workspace\my-project --thread <thread-uuid>
```

`--project` 和 `--mr` 可重复传入，也可用逗号分隔；不传表示匹配全部项目或全部 MR。

## 角色

- `reviewer`：监听新 MR 和已有 MR 的状态变化，创建或通知审查线程。
- `developer`：监听自己创建的 MR，或 `developer.watchMergeRequests` 指定的 MR，通知开发者会话继续处理。

```powershell
npx @alanwalk/mr-watch --workspace C:\Workspace\my-project --role developer --thread <thread-uuid>
```

## 配置

工作区数据默认位于 `<workspace>/.mr-watch/`：

- `config.json`：项目、轮询间隔、角色映射和 App Server 地址。
- `agents.json`：已注册的 Codex thread 和 HTTP hook。
- `credentials.json`：按 GitLab host 保存的 Token，目录内 `.gitignore` 默认忽略全部内容。
- `state-reviewer.json` / `state-developer.json`：MR 状态快照。
- `events.jsonl`：管理页历史事件。

常用启动参数：

```text
--workspace <path>       工作区 Git 根目录，默认当前目录
--role reviewer|developer
--thread <uuid>          developer 模式的目标 Codex 会话
--project <path>         可重复或逗号分隔
--interval <ms>          轮询间隔，默认 60000
--app-server-url <url>   默认 ws://127.0.0.1:18787
--dashboard-port <port>  默认 8787
--dashboard-host <host>  默认 127.0.0.1
--no-dashboard
--once
--dry-run
```

## 审查线程

审核端通过 Codex App Server WebSocket 创建审查线程，并由 MR 映射保存 thread UUID。若 App Server 未运行，会在需要创建线程时尝试启动。

管理页可查看当前映射、活跃 MR、注册会话和历史事件；新 MR 的审查线程会出现在 Codex 侧边栏的任务列表中。

## 本地部署与安全

- 管理页默认只监听 `127.0.0.1`，不要在没有额外认证的情况下暴露到公网。
- Token 只保存在本机工作区数据目录，不写入 GitLab 仓库，也不输出到日志或管理页。
- 程序不会自动合并 MR、提交代码或发布评论；只有明确的会话指令或 hook 处理逻辑才会触发后续动作。

## 后续开发

独立服务化、多项目管理和旧数据迁移方案见 [cloud-server-handoff.md](./docs/cloud-server-handoff.md)。
