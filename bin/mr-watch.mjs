#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getConfigPath, getProjectPath, loadOrCreateConfig, normalizeGitLabHost,
  prepareProject, resolveServiceHome, saveGitLabToken, updateConfig,
} from '../src/workspace.mjs';
import { listAgents, registerAgent, unregisterAgent } from '../src/registry.mjs';
import { TokenGitLabClient } from '../src/gitlab-client.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const knownCommands = new Set(['start', 'init', 'auth', 'register', 'unregister', 'list', 'project']);

function printHelp() {
  console.log(`MR Watch 独立服务

用法:
  mr-watch [start] [--role reviewer|developer]
  mr-watch init
  mr-watch auth --host https://git.example.com --token-stdin
  mr-watch project add --workspace /absolute/path/to/repo [--project team/project]
  mr-watch project add --project team/project [--host https://git.example.com]
  mr-watch project list
  mr-watch project remove --project team/project
  mr-watch register --thread <uuid> --role developer --project team/project --mr 22
  mr-watch register --hook-url http://127.0.0.1:9100/mr-watch --project team/project
  mr-watch list [--json]
  mr-watch unregister --id <agent-id>

通用参数:
  --home <path>           服务数据目录；优先于 MR_WATCH_HOME，默认 ~/.config/mr-watch
  --config <path>         仅覆盖配置文件；其余数据仍位于服务目录

启动参数:
  --role reviewer|developer  默认读取配置 role（reviewer）
  --project <path>           仅轮询选中的已配置项目，可重复或逗号分隔
  --notify <project!iid>     手动通知；纯 IID 仅限单项目或同时指定 --project
  --mr <iid>                --notify 的别名
  --thread <uuid>           developer 默认目标会话，优先使用项目 agent 路由
  --interval <ms>           最小 10000，默认 60000
  --app-server-url <url>    默认 ws://127.0.0.1:18787
  --review-model <model>
  --review-effort <effort>
  --dashboard-host <host>   默认 127.0.0.1
  --dashboard-port <port>   默认 8787
  --no-dashboard --once --dry-run

认证参数:
  --host <url>              服务 GitLab 地址；已有项目时不可切换至其他 host
  --token-stdin             从标准输入读取 Token
  --token <token>           直接提供 Token

注册参数:
  --thread <uuid> 或 --hook-url <http(s) url>
  --role developer|reviewer --project <path> --mr <iid> --label <text> --json
  --project 和 --mr 支持重复或逗号分隔；多项目下 --mr 必须指定 --project
`);
}

function extractOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少值`);
  args.splice(index, 2);
  return value;
}
function extractAllOptions(args, name) {
  const values = [];
  for (let value; (value = extractOption(args, name)) !== null;) {
    values.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
  }
  return values;
}
function hasFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}
function assertNoArguments(args) {
  if (args.length) throw new Error(`未知参数: ${args.join(' ')}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    console.log(JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')).version);
    return;
  }
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printHelp(); return;
  }
  const serviceHome = resolveServiceHome(extractOption(args, '--home'));
  const configPath = getConfigPath(serviceHome, extractOption(args, '--config'));
  const command = knownCommands.has(args[0]) ? args.shift() : 'start';
  const store = { serviceHome, configPath };
  const config = await loadOrCreateConfig(store);

  if (command === 'init') {
    assertNoArguments(args);
    console.log(`home=${serviceHome}\nconfig=${configPath}\nprojects=${config.projects.map(getProjectPath).join(',')}`);
    return;
  }
  if (command === 'project') {
    const action = args.shift();
    const path = extractOption(args, '--project');
    const workspace = extractOption(args, '--workspace');
    const host = extractOption(args, '--host');
    assertNoArguments(args);
    if (action === 'list') {
      console.log(JSON.stringify(config.projects, null, 2)); return;
    }
    await updateConfig(store, (latest) => {
      if (host) {
        const normalized = normalizeGitLabHost(host);
        if (latest.projects.length && latest.gitlabHost && normalized !== latest.gitlabHost) {
          throw new Error('已有项目时不能切换 GitLab host，请先删除项目');
        }
        latest.gitlabHost = normalized;
      }
      if (action === 'add') prepareProject(latest, { path, workspace });
      else if (action === 'remove') {
        if (!path || !latest.projects.some((project) => project.path === path)) throw new Error('项目不存在');
        latest.projects = latest.projects.filter((project) => project.path !== path);
      } else throw new Error('project 支持 add、remove、list');
    });
    console.log(`project ${action}: ${path || workspace}`);
    return;
  }
  if (command === 'auth') {
    const host = normalizeGitLabHost(extractOption(args, '--host') || config.gitlabHost);
    let token = extractOption(args, '--token');
    if (hasFlag(args, '--token-stdin')) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      token = Buffer.concat(chunks).toString('utf8').trim();
    }
    assertNoArguments(args);
    if (!host) throw new Error('请使用 --host 配置 GitLab 地址');
    if (!token) throw new Error('请使用 --token-stdin 或 --token 提供 Token');
    const currentUser = await new TokenGitLabClient({ host, token }).currentUser();
    await updateConfig(store, async (latest) => {
      if (latest.projects.length && latest.gitlabHost && latest.gitlabHost !== host) {
        throw new Error('已有项目时不能切换 GitLab host，请先删除项目');
      }
      await saveGitLabToken({ serviceHome, host, token });
      latest.gitlabHost = host;
    });
    console.log(`gitlab=${host}\ncurrentUser=${currentUser}\nGitLab Token 已验证并保存。`);
    return;
  }
  if (command === 'register') {
    const json = hasFlag(args, '--json');
    const params = {
      serviceHome, config,
      threadId: extractOption(args, '--thread'), hookUrl: extractOption(args, '--hook-url'),
      role: extractOption(args, '--role') || 'developer', label: extractOption(args, '--label'),
      projects: extractAllOptions(args, '--project'), mrIids: extractAllOptions(args, '--mr'),
    };
    assertNoArguments(args);
    const agent = await registerAgent(params);
    console.log(json ? JSON.stringify(agent, null, 2) : `registered=${agent.id}\nprojects=${agent.projects.join(',') || '*'}\nmrIids=${agent.mrIids.join(',') || '*'}`);
    return;
  }
  if (command === 'unregister') {
    const id = extractOption(args, '--id');
    const threadId = extractOption(args, '--thread');
    assertNoArguments(args);
    if (!id && !threadId) throw new Error('unregister 需要 --id 或 --thread');
    console.log(`removed=${await unregisterAgent({ serviceHome, id, threadId })}`);
    return;
  }
  if (command === 'list') {
    hasFlag(args, '--json');
    assertNoArguments(args);
    console.log(JSON.stringify(await listAgents(serviceHome), null, 2));
    return;
  }
  const child = spawn(process.execPath, [resolve(packageRoot, 'watch.mjs'), ...args], {
    cwd: serviceHome,
    env: { ...process.env, MR_WATCH_HOME: serviceHome, MR_WATCH_CONFIG: configPath },
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}
main().catch((error) => { console.error(`mr-watch: ${error.message}`); process.exitCode = 1; });
