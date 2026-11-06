#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getConfigPath,
  getDataDir,
  inferGitLabRemote,
  loadOrCreateConfig,
  resolveWorkspaceRoot,
  saveGitLabToken,
} from '../src/workspace.mjs';
import {
  listAgents,
  registerAgent,
  unregisterAgent,
} from '../src/registry.mjs';
import { TokenGitLabClient } from '../src/gitlab-client.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const knownCommands = new Set(['start', 'init', 'auth', 'register', 'unregister', 'list']);

function printHelp() {
  console.log(`MR Watch

用法:
  npx @alanwalk/mr-watch
  npx @alanwalk/mr-watch start --workspace C:\\Workspace\\my-project --role reviewer
  npx @alanwalk/mr-watch auth --workspace C:\\Workspace\\my-project --token-stdin
  npx @alanwalk/mr-watch register --workspace C:\\Workspace\\my-project --thread <thread-uuid> --role developer --mr 22
  npx @alanwalk/mr-watch register --workspace C:\\Workspace\\my-project --hook-url http://127.0.0.1:9100/mr-watch --project team/project
  npx @alanwalk/mr-watch list --workspace C:\\Workspace\\my-project
  npx @alanwalk/mr-watch unregister --workspace C:\\Workspace\\my-project --id <agent-id>
  npx @alanwalk/mr-watch init --workspace C:\\Workspace\\my-project

认证参数:
  --token <token>          直接提供 GitLab Personal Access Token
  --token-stdin            从标准输入读取 Token，避免进入命令历史
  --host <url>             覆盖从 origin remote 解析出的 GitLab 地址

启动参数:
  --workspace <path>       工作区 Git 根目录，默认当前目录
  --config <path>          覆盖配置文件路径，默认 <workspace>/.mr-watch/config.json
  --role reviewer|developer
  --project <path>         可重复或逗号分隔
  --thread <uuid>          开发者模式目标会话
  --notify <iid>           手动通知开发者继续处理
  --interval <ms>          轮询间隔，默认 60000
  --app-server-url <url>   默认 ws://127.0.0.1:18787
  --review-model <model>
  --review-effort <effort>
  --dashboard-port <port>  默认 8787
  --dashboard-host <host>  默认 127.0.0.1
  --no-dashboard
  --once
  --dry-run

注册参数:
  --thread <uuid>          要接收通知的 Codex 会话
  --hook-url <url>         HTTP 通知地址，可和 thread 二选一
  --role developer|reviewer
  --project <path>         可重复或逗号分隔
  --mr <iid>               可重复或逗号分隔；为空表示该项目全部 MR
  --label <text>
  --json                   输出 JSON
`);
}

function extractOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = args[index + 1] ?? null;
  args.splice(index, 2);
  return value;
}

function extractAllOptions(args, name) {
  const values = [];
  while (true) {
    const value = extractOption(args, name);
    if (value === null) {
      break;
    }
    values.push(...String(value).split(',').map((item) => item.trim()).filter(Boolean));
  }
  return values;
}

function hasFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

async function readPackageVersion() {
  const packageJson = JSON.parse(
    await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
  );
  return packageJson.version;
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
    console.log(await readPackageVersion());
    return;
  }

  if (rawArgs[0] === 'help' || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    printHelp();
    return;
  }

  const command = knownCommands.has(rawArgs[0]) ? rawArgs.shift() : 'start';
  const workspaceArg = extractOption(rawArgs, '--workspace') ?? process.cwd();
  const configOverride = extractOption(rawArgs, '--config');
  const workspaceRoot = resolveWorkspaceRoot(workspaceArg);
  const configPath = getConfigPath(workspaceRoot, configOverride);

  if (command === 'init') {
    const config = await loadOrCreateConfig({ workspaceRoot, configPath });
    console.log(`workspace=${workspaceRoot}`);
    console.log(`dataDir=${getDataDir(workspaceRoot)}`);
    console.log(`config=${configPath}`);
    console.log(`projects=${config.projects.join(',')}`);
    return;
  }

  if (command === 'auth') {
    const hostOverride = extractOption(rawArgs, '--host');
    const tokenOption = extractOption(rawArgs, '--token');
    const tokenFromStdin = hasFlag(rawArgs, '--token-stdin');
    const gitlabInfo = inferGitLabRemote(workspaceRoot);
    const host = hostOverride
      ? String(hostOverride).trim().replace(/\/+$/, '')
      : gitlabInfo.host;
    const token = tokenFromStdin
      ? await readStdinText()
      : tokenOption;

    console.log(`workspace=${workspaceRoot}`);
    console.log(`gitlab=${host}/${gitlabInfo.project}`);
    console.log(`tokenPage=${gitlabInfo.tokenSettingsUrl}`);

    if (!token) {
      throw new Error('缺少 Token，请使用 --token-stdin 从标准输入读取，或使用 --token');
    }

    const gitlab = new TokenGitLabClient({ host, token });
    const currentUser = await gitlab.currentUser();
    await saveGitLabToken({ workspaceRoot, host, token });

    console.log(`currentUser=${currentUser}`);
    console.log('GitLab Token 已验证并保存。');
    return;
  }

  if (command === 'register') {
    const json = hasFlag(rawArgs, '--json');
    const threadId = extractOption(rawArgs, '--thread');
    const hookUrl = extractOption(rawArgs, '--hook-url');
    const role = extractOption(rawArgs, '--role') ?? 'developer';
    const label = extractOption(rawArgs, '--label');
    const projects = extractAllOptions(rawArgs, '--project');
    const mrIids = extractAllOptions(rawArgs, '--mr');
    const config = await loadOrCreateConfig({ workspaceRoot, configPath });
    const agent = await registerAgent({
      workspaceRoot,
      config,
      threadId,
      hookUrl,
      role,
      projects,
      mrIids,
      label,
    });

    if (json) {
      console.log(JSON.stringify(agent, null, 2));
    } else {
      console.log(`registered=${agent.id}`);
      console.log(`role=${agent.role}`);
      console.log(`projects=${agent.projects.join(',') || '*'}`);
      console.log(`mrIids=${agent.mrIids.join(',') || '*'}`);
      console.log(`threadId=${agent.threadId ?? '-'}`);
      console.log(`hookUrl=${agent.hookUrl ?? '-'}`);
    }
    return;
  }

  if (command === 'unregister') {
    const id = extractOption(rawArgs, '--id');
    const threadId = extractOption(rawArgs, '--thread');
    if (!id && !threadId) {
      throw new Error('unregister 需要 --id 或 --thread');
    }
    const removedCount = await unregisterAgent({ workspaceRoot, id, threadId });
    console.log(`removed=${removedCount}`);
    return;
  }

  if (command === 'list') {
    const json = hasFlag(rawArgs, '--json');
    const agents = await listAgents(workspaceRoot);
    if (json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }
    if (agents.length === 0) {
      console.log('没有已注册的 agent。');
      return;
    }
    for (const agent of agents) {
      console.log([
        agent.id,
        agent.role,
        agent.label ?? '-',
        `projects=${agent.projects.join(',') || '*'}`,
        `mrs=${agent.mrIids.join(',') || '*'}`,
        `thread=${agent.threadId ?? '-'}`,
        `hook=${agent.hookUrl ?? '-'}`,
      ].join(' | '));
    }
    return;
  }

  const watcherPath = resolve(packageRoot, 'watch.mjs');
  const child = spawn(process.execPath, [watcherPath, ...rawArgs], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      MR_WATCH_WORKSPACE: workspaceRoot,
      MR_WATCH_CONFIG: configPath,
    },
    stdio: 'inherit',
    windowsHide: false,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  console.error(`mr-watch: ${error.message}`);
  process.exit(1);
});
