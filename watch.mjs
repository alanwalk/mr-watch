import { execFileSync } from 'node:child_process';
import { watch as watchDirectory } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAppServerClient } from './app-server-client.mjs';
import {
  DEFAULT_APP_SERVER_URL,
  getConfigPath,
  getDataDir,
  getGitLabCredentialInfo,
  getEventLogPath,
  buildGitLabTokenSettingsUrl,
  normalizeGitLabHost,
  normalizeProjects,
  getProjectPath,
  getProjectWorkspace,
  prepareProject,
  resolveGitLabToken,
  updateConfig,
  loadOrCreateConfig,
  resolveServiceHome,
  saveGitLabToken,
} from './src/workspace.mjs';
import {
  agentMatches,
  listAgents,
} from './src/registry.mjs';
import {
  createGitLabClient,
  TokenGitLabClient,
} from './src/gitlab-client.mjs';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const serviceHome = resolveServiceHome();
const configPath = getConfigPath(serviceHome, process.env.MR_WATCH_CONFIG);
const dataDir = getDataDir(serviceHome);
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 10_000;
const DEFAULT_DASHBOARD_PORT = 8787;
const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
const MAX_NOTE_PREVIEW = 400;
const MAX_NOTES_IN_MESSAGE = 5;
const AGENT_NOTE_MARKERS = [
  '<!-- codex-review -->',
  '[Codex Review]',
  '[Codex 审查]',
];
const TERMINAL_PIPELINE_STATUSES = new Set(['success', 'failed', 'canceled']);
const ATTENTION_MERGE_STATUSES = new Set([
  'conflict',
  'need_rebase',
  'cannot_be_merged',
  'discussions_not_resolved',
  'ci_must_pass',
  'not_approved',
]);
const REVIEW_ATTENTION_MERGE_STATUSES = new Set([
  'conflict',
  'need_rebase',
  'cannot_be_merged',
]);

let lastGoodConfig = null;
const runtimeStatus = {
  role: null,
  startedAt: null,
  lastPollAt: null,
  lastPollFinishedAt: null,
  lastPollDurationMs: null,
  nextPollAt: null,
  isPolling: false,
  lastError: null,
  dashboardUrl: null,
};

function printUsage() {
  console.log(`GitLab MR 自动跟进

用法:
  npm start
  node watch.mjs --role reviewer
  node watch.mjs --role developer
  node watch.mjs --role developer --notify 20
  node watch.mjs --role reviewer --once --dry-run

选项:
  --role reviewer|developer   指定运行角色
  --notify <iid>              普通开发者手动通知 agent 继续处理指定 MR
  --thread <uuid>             覆盖目标 Codex 会话 ID
  --project <path>            覆盖项目路径，可重复或逗号分隔
  --interval <ms>             覆盖轮询间隔，最小 ${MIN_POLL_INTERVAL_MS} ms
  --app-server-url <url>      覆盖 App Server URL
  --review-model <model>      覆盖审查线程模型
  --review-effort <effort>    覆盖审查线程 reasoning
  --dashboard-host <host>     覆盖管理页面监听地址
  --dashboard-port <port>     覆盖管理页面端口
  --no-dashboard              不启动管理页面
  --once                      只检查一轮
  --dry-run                   只打印将要投递的消息，不调用 codex queue
  --help                      显示帮助
`);
}

function parseArguments(argv) {
  const options = {
    role: null,
    notify: null,
    thread: null,
    projectRefs: [],
    intervalMs: null,
    appServerUrl: null,
    reviewModel: null,
    reviewEffort: null,
    dashboardHost: null,
    dashboardPort: null,
    noDashboard: false,
    once: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--role') {
      options.role = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--notify' || argument === '--mr') {
      options.notify = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--thread') {
      options.thread = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--project') {
      options.projectRefs.push(
        ...String(argv[index + 1] ?? '')
          .split(',')
          .map((project) => project.trim())
          .filter((project) => project.length > 0),
      );
      index += 1;
      continue;
    }

    if (argument === '--interval') {
      options.intervalMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (argument === '--app-server-url') {
      options.appServerUrl = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--review-model') {
      options.reviewModel = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--review-effort') {
      options.reviewEffort = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--dashboard-host' || argument === '--host') {
      options.dashboardHost = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--dashboard-port' || argument === '--port') {
      options.dashboardPort = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (argument === '--no-dashboard') {
      options.noDashboard = true;
      continue;
    }

    if (argument === '--once') {
      options.once = true;
      continue;
    }

    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    throw new Error(`未知参数: ${argument}`);
  }

  if (options.role !== null && !['reviewer', 'developer'].includes(options.role)) {
    throw new Error(`--role 只支持 reviewer 或 developer，当前值: ${options.role}`);
  }

  if (options.intervalMs !== null && (!Number.isInteger(options.intervalMs) || options.intervalMs < MIN_POLL_INTERVAL_MS)) {
    throw new Error(`--interval 必须是不小于 ${MIN_POLL_INTERVAL_MS} 的整数毫秒数`);
  }

  if (
    options.dashboardPort !== null
    && (!Number.isInteger(options.dashboardPort) || options.dashboardPort <= 0 || options.dashboardPort > 65535)
  ) {
    throw new Error(`--dashboard-port 必须是 1 到 65535 之间的整数，当前值: ${options.dashboardPort}`);
  }

  if (options.notify !== null && !/^(?:[^!]+!)?[1-9]\d*$/.test(options.notify)) {
    throw new Error('--notify 必须是 project/path!IID 或有效的 MR IID');
  }

  return options;
}

function validateConfig(config) {
  if (config.version !== 2) throw new Error('config.json 需要 version: 2');
  config.projects = normalizeProjects(config.projects);
  config.gitlabHost = normalizeGitLabHost(config.gitlabHost);
  if (config.reviewThreads === null || typeof config.reviewThreads !== 'object' || Array.isArray(config.reviewThreads)) {
    config.reviewThreads = {};
  }

  if (!Array.isArray(config.ignoreAuthors)) {
    config.ignoreAuthors = [];
  }

  if (config.developer === null || typeof config.developer !== 'object' || Array.isArray(config.developer)) {
    config.developer = {};
  }

  if (!Array.isArray(config.developer.watchMergeRequests)) {
    config.developer.watchMergeRequests = [];
  }

  if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < MIN_POLL_INTERVAL_MS) {
    config.pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  }

  if (
    !Number.isInteger(config.dashboardPort)
    || config.dashboardPort <= 0
    || config.dashboardPort > 65535
  ) {
    config.dashboardPort = DEFAULT_DASHBOARD_PORT;
  }

  if (typeof config.dashboardHost !== 'string' || config.dashboardHost.trim().length === 0) {
    config.dashboardHost = DEFAULT_DASHBOARD_HOST;
  }

  config.watchEventLogPath = 'events.jsonl';
  config.watchEventLogPathResolved = getEventLogPath(serviceHome);
  config.appServerUrl = typeof config.appServerUrl === 'string' && config.appServerUrl.trim().length > 0
    ? config.appServerUrl.trim()
    : DEFAULT_APP_SERVER_URL;
  config.reviewModel = typeof config.reviewModel === 'string'
    ? config.reviewModel.trim()
    : '';
  config.reviewEffort = typeof config.reviewEffort === 'string'
    ? config.reviewEffort.trim()
    : '';

  return config;
}

async function loadConfigFromDisk() {
  const config = await loadOrCreateConfig({ serviceHome, configPath });
  return validateConfig(config);
}

async function loadConfigSafely() {
  try {
    const config = await loadConfigFromDisk();
    lastGoodConfig = config;
    return config;
  } catch (error) {
    if (lastGoodConfig) {
      console.error(`读取 config.json 失败，沿用上次有效配置: ${error.message}`);
      return lastGoodConfig;
    }
    throw new Error(`读取 config.json 失败: ${error.message}`);
  }
}

function applyOptions(config, options, strict = false) {
  const effective = { ...config };
  for (const key of ['appServerUrl', 'reviewModel', 'reviewEffort', 'dashboardHost']) {
    if (options[key] !== null) effective[key] = options[key];
  }
  if (options.projectRefs.length) {
    if (strict) {
      const missing = options.projectRefs.find((path) => !config.projects.some((item) => item.path === path));
      if (missing) throw new Error(`项目未配置: ${missing}`);
    }
    effective.projects = config.projects.filter((project) => options.projectRefs.includes(project.path));
  }
  return effective;
}

async function mutateConfig(mutate) {
  const result = await updateConfig({ serviceHome, configPath }, (config) => {
    validateConfig(config);
    delete config.watchEventLogPathResolved;
    return mutate(config);
  });
  lastGoodConfig = await loadConfigFromDisk();
  return result;
}

async function resolveRole(options, config) {
  const role = options.notify !== null ? 'developer' : options.role || config.role || 'reviewer';
  if (!['reviewer', 'developer'].includes(role)) throw new Error('role 只支持 reviewer 或 developer');
  return role;
}

function runCommand(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: serviceHome,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    const stdout = error.stdout ? String(error.stdout).trim() : '';
    const detail = stderr || stdout || error.message;
    throw new Error(`${command} ${args.join(' ')} 执行失败: ${detail}`);
  }
}

function runCodexQueue(threadId, message) {
  return runCommand('codex', [
    'queue',
    '--thread',
    threadId,
    '--message',
    message,
    '--resume',
  ]);
}

async function listAllOpenMergeRequests(gitlab, project) {
  const mergeRequests = [];
  const pageSize = 100;

  for (let page = 1; page <= 10; page += 1) {
    const pageItems = await gitlab.listOpenMergeRequests(project, page, pageSize);
    if (!Array.isArray(pageItems)) {
      throw new Error(`项目 ${project} 的 MR 列表格式不是数组`);
    }
    mergeRequests.push(...pageItems);
    if (pageItems.length < pageSize) {
      break;
    }
  }

  return mergeRequests;
}

function collectNotes(mergeRequest) {
  const discussions = Array.isArray(mergeRequest.Discussions)
    ? mergeRequest.Discussions
    : Array.isArray(mergeRequest.discussions)
      ? mergeRequest.discussions
      : [];

  const notes = [];
  for (const discussion of discussions) {
    if (Array.isArray(discussion.notes)) {
      notes.push(...discussion.notes);
    }
  }

  return notes.sort((leftNote, rightNote) => Number(leftNote.id) - Number(rightNote.id));
}

function collectWatchedNotes(mergeRequest, ignoredAuthors) {
  return collectNotes(mergeRequest).filter((note) => {
    if (note.system) {
      return false;
    }
    if (AGENT_NOTE_MARKERS.some((marker) => String(note.body ?? '').includes(marker))) {
      return false;
    }
    return !ignoredAuthors.has(note.author?.username);
  });
}

function latestNoteId(notes) {
  return notes.reduce((maxId, note) => Math.max(maxId, Number(note.id) || 0), 0);
}

function shortSha(sha) {
  return typeof sha === 'string' && sha.length > 0 ? sha.slice(0, 8) : '(unknown)';
}

function formatNote(note) {
  const body = String(note.body ?? '').replace(/\s+/g, ' ').trim();
  const preview = body.length > MAX_NOTE_PREVIEW
    ? `${body.slice(0, MAX_NOTE_PREVIEW)}…`
    : body;
  return `- @${note.author?.username ?? 'unknown'} (note ${note.id}): ${preview || '(无正文)'}`;
}

function formatNewNotes(notes, previousNoteId) {
  return notes
    .filter((note) => Number(note.id) > Number(previousNoteId ?? 0))
    .slice(-MAX_NOTES_IN_MESSAGE)
    .map(formatNote)
    .join('\n');
}

function buildReviewerFingerprint(mergeRequest, latestWatchedNoteId) {
  return JSON.stringify({
    sha: mergeRequest.sha ?? null,
    state: mergeRequest.state ?? null,
    pipelineStatus: mergeRequest.head_pipeline?.status ?? null,
    pipelineSha: mergeRequest.head_pipeline?.sha ?? null,
    mergeStatus: mergeRequest.detailed_merge_status ?? null,
    latestWatchedNoteId,
  });
}

function buildDeveloperFingerprint(mergeRequest, latestWatchedNoteId) {
  return JSON.stringify({
    state: mergeRequest.state ?? null,
    pipelineStatus: mergeRequest.head_pipeline?.status ?? null,
    mergeStatus: mergeRequest.detailed_merge_status ?? null,
    latestWatchedNoteId,
  });
}

function buildMergeRequestState(mergeRequest, fingerprint, latestWatchedNoteId) {
  const now = new Date().toISOString();
  return {
    fingerprint,
    headSha: mergeRequest.sha ?? null,
    pipelineStatus: mergeRequest.head_pipeline?.status ?? null,
    mergeStatus: mergeRequest.detailed_merge_status ?? null,
    latestWatchedNoteId,
    title: mergeRequest.title ?? null,
    author: mergeRequest.author?.username ?? null,
    webUrl: mergeRequest.web_url ?? null,
    sourceBranch: mergeRequest.source_branch ?? null,
    targetBranch: mergeRequest.target_branch ?? null,
    updatedAt: now,
    lastSeenAt: now,
  };
}

function refreshMergeRequestMetadata(stateEntry, mergeRequest) {
  stateEntry.title = mergeRequest.title ?? stateEntry.title ?? null;
  stateEntry.author = mergeRequest.author?.username ?? stateEntry.author ?? null;
  stateEntry.webUrl = mergeRequest.web_url ?? stateEntry.webUrl ?? null;
  stateEntry.sourceBranch = mergeRequest.source_branch ?? stateEntry.sourceBranch ?? null;
  stateEntry.targetBranch = mergeRequest.target_branch ?? stateEntry.targetBranch ?? null;
  stateEntry.lastSeenAt = new Date().toISOString();
}

function getReviewThreadId(config, project, mergeRequestIid) {
  return config.reviewThreads[`${project}!${mergeRequestIid}`] ?? null;
}

async function persistReviewThreadMapping(config, project, mergeRequestIid, threadId) {
  const mappingKey = `${project}!${mergeRequestIid}`;
  await mutateConfig((latest) => { latest.reviewThreads[mappingKey] = threadId; });
  config.reviewThreads[mappingKey] = threadId;
}

function buildReviewThreadTitle(project, mergeRequest) {
  return `代码审查 | ${project} !${mergeRequest.iid}`;
}

function buildReviewPrompt(project, mergeRequest, projectConfig) {
  return [
    `你是独立审查线程，审查 GitLab MR !${mergeRequest.iid}（${project}）。`,
    projectConfig.workspace
      ? `本地仓库: ${projectConfig.workspace}。本地文件核对仅限此项目目录。`
      : '此项目未配置 workspace。只能使用 GitLab API 审查；当前 cwd 是服务目录，不是项目仓库，不得读取本地项目文件进行核对。',
    `标题: ${mergeRequest.title ?? '(无标题)'}`,
    `作者: ${mergeRequest.author?.username ?? 'unknown'}`,
    `分支: ${mergeRequest.source_branch ?? '?'} -> ${mergeRequest.target_branch ?? '?'}`,
    `head: ${mergeRequest.sha ?? '(unknown)'}`,
    `状态: ${mergeRequest.state ?? '?'} / ${mergeRequest.detailed_merge_status ?? '?'}`,
    `链接: ${mergeRequest.web_url ?? '(无)'}`,
    '',
    '请先核对最新 head、目标分支、标题、描述、提交列表、完整 diff、讨论、pipeline 和依赖关系。',
    '只读审查：不要修改工作区文件，不要提交、推送、合并或关闭 MR，不要发布 MR 评论，除非用户明确要求。',
    '',
    '按项目 AGENTS.md 和项目规范审查，重点检查：',
    '- 业务正确性、边界条件、状态流转和回归风险',
    '- 业务目标是否集中，是否夹带无关改动',
    '- 代码分层、协议与配置来源、资源命名、构建链和共享组件影响',
    '- 测试和验证证据是否覆盖实际改动；缺失项要指出',
    '- 代码可读性：是否绕路查询、嵌套三元、过长调用或匿名回调夹带多步逻辑',
    '',
    '输出中文审查结论，至少包含：MR 摘要、结论（通过/需修改）、阻断问题、重要问题、一般问题（尽量给出 file:line 和证据）、验证缺口、未核实范围。',
    '如果用户明确要求发布 MR 评论，请在评论正文开头加 `<!-- codex-review -->`。',
  ].join('\n');
}

const REVIEW_THREAD_INSTRUCTIONS = [
  '这是一条 GitLab MR 审查线程。',
  '保持只读：不要修改工作区文件，不要提交、推送、合并或关闭 MR。',
  '未经用户明确要求，不要发布 MR 评论。',
  '需要 GitLab 数据时使用已配置的 GitLab Token API 或 glab，不要使用浏览器或 Computer Use。',
].join('\n');

function buildReviewerUpdateMessage(project, mergeRequest, previousState, newNotesText) {
  const previousHead = previousState?.headSha ?? '(unknown)';
  const previousPipeline = previousState?.pipelineStatus ?? '(unknown)';
  const previousMergeStatus = previousState?.mergeStatus ?? '(unknown)';

  return [
    '[MR-WATCH][UPDATE] MR 有变化',
    `项目: ${project}`,
    `MR: !${mergeRequest.iid} ${mergeRequest.title ?? ''}`,
    `head: ${shortSha(previousHead)} -> ${shortSha(mergeRequest.sha)}`,
    `pipeline: ${previousPipeline} -> ${mergeRequest.head_pipeline?.status ?? 'none'}`,
    `merge status: ${previousMergeStatus} -> ${mergeRequest.detailed_merge_status ?? 'unknown'}`,
    `链接: ${mergeRequest.web_url ?? '(无)'}`,
    '',
    newNotesText ? `新讨论:\n${newNotesText}` : '新讨论: 无（变化来自提交、pipeline 或状态）',
    '',
    '请重新核对最新 head、完整 diff、讨论、pipeline 和依赖，更新审查结论。保持只读；不要发布 MR 评论，除非用户明确要求。若发布评论，请在正文开头加 `<!-- codex-review -->`。',
  ].join('\n');
}

function buildDeveloperMessage(project, mergeRequest, previousState, newNotesText) {
  const previousPipeline = previousState?.pipelineStatus ?? '(unknown)';
  const previousMergeStatus = previousState?.mergeStatus ?? '(unknown)';

  return [
    '[MR-WATCH][DEV] MR 有新的处理信号',
    `项目: ${project}`,
    `MR: !${mergeRequest.iid} ${mergeRequest.title ?? ''}`,
    `head: ${shortSha(mergeRequest.sha)}`,
    `pipeline: ${previousPipeline} -> ${mergeRequest.head_pipeline?.status ?? 'none'}`,
    `merge status: ${previousMergeStatus} -> ${mergeRequest.detailed_merge_status ?? 'unknown'}`,
    `链接: ${mergeRequest.web_url ?? '(无)'}`,
    '',
    newNotesText ? `新的审查讨论:\n${newNotesText}` : '新的审查讨论: 无',
    '',
    '请继续处理该 MR：先核对最新审查意见和 CI 状态，修复代码并运行相关验证；不要自动合并，也不要跳过未通过的检查。完成后总结改动、验证结果和未解决项。',
  ].join('\n');
}

function buildManualDeveloperMessage(project, mergeRequest) {
  return [
    '[MR-WATCH][DEV-MANUAL] 用户要求继续处理 MR',
    `项目: ${project}`,
    `MR: !${mergeRequest.iid} ${mergeRequest.title ?? ''}`,
    `head: ${shortSha(mergeRequest.sha)}`,
    `pipeline: ${mergeRequest.head_pipeline?.status ?? 'none'}`,
    `merge status: ${mergeRequest.detailed_merge_status ?? 'unknown'}`,
    `链接: ${mergeRequest.web_url ?? '(无)'}`,
    '',
    '请继续处理该 MR：核对最新讨论和 CI，完成必要的修复与验证；不要自动合并。',
  ].join('\n');
}

async function queueThreadMessage(threadId, message, options) {
  if (options.dryRun) {
    console.log(`\n[DRY-RUN] 目标会话: ${threadId}`);
    console.log(message);
    console.log('');
    return;
  }

  runCodexQueue(threadId, message);
  const firstLine = message.split('\n')[0];
  console.log(`已投递到会话 ${threadId}: ${firstLine}`);
}

function buildAgentMessage(project, mergeRequest, eventType, newNotesText, agent) {
  const action = agent.role === 'reviewer'
    ? '请继续审查该 MR，核对最新 head、diff、讨论、pipeline 和依赖，并更新结论。'
    : '请继续处理该 MR，核对最新审查意见和 CI，完成必要的修复与验证。';

  return [
    `[MR-WATCH][AGENT] ${eventType === 'thread_created' ? '审查线程已创建' : 'MR 审核状态有变化'}`,
    `项目: ${project}`,
    `MR: !${mergeRequest.iid} ${mergeRequest.title ?? ''}`,
    `head: ${shortSha(mergeRequest.sha)}`,
    `pipeline: ${mergeRequest.head_pipeline?.status ?? 'none'}`,
    `merge status: ${mergeRequest.detailed_merge_status ?? 'unknown'}`,
    `链接: ${mergeRequest.web_url ?? '(无)'}`,
    '',
    newNotesText ? `新讨论:\n${newNotesText}` : '新讨论: 无',
    '',
    action,
    '不要自动合并，也不要跳过未通过的检查。',
  ].join('\n');
}

async function postAgentHook(agent, payload) {
  const response = await fetch(agent.hookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'mr-watch/0.1.0',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`hook ${agent.hookUrl} 返回 HTTP ${response.status}`);
  }
}

async function notifyRegisteredAgents(
  config,
  project,
  mergeRequest,
  eventType,
  newNotesText,
  options,
  alreadyNotifiedThreadIds = new Set(),
) {
  let agents;
  try {
    agents = await listAgents(serviceHome);
  } catch (error) {
    console.error(`读取 agent 注册表失败: ${error.message}`);
    return 0;
  }

  let notifiedCount = 0;
  for (const agent of agents) {
    if (!agentMatches(agent, project, mergeRequest.iid)) {
      continue;
    }
    if (
      agent.threadId
      && alreadyNotifiedThreadIds.has(agent.threadId)
      && !agent.hookUrl
    ) {
      continue;
    }

    const message = buildAgentMessage(project, mergeRequest, eventType, newNotesText, agent);
    try {
      if (agent.threadId && !alreadyNotifiedThreadIds.has(agent.threadId)) {
        await queueThreadMessage(agent.threadId, message, options);
        alreadyNotifiedThreadIds.add(agent.threadId);
      }

      if (agent.hookUrl) {
        if (options.dryRun) {
          console.log(`[DRY-RUN] POST hook ${agent.hookUrl}`);
          console.log(message);
        } else {
          await postAgentHook(agent, {
            event: eventType,
            project,
            mrIid: Number(mergeRequest.iid),
            title: mergeRequest.title ?? null,
            headSha: mergeRequest.sha ?? null,
            pipelineStatus: mergeRequest.head_pipeline?.status ?? null,
            mergeStatus: mergeRequest.detailed_merge_status ?? null,
            webUrl: mergeRequest.web_url ?? null,
            message,
            timestamp: new Date().toISOString(),
          });
        }
      }

      notifiedCount += 1;
      if (!options.dryRun) {
        await recordWatchEventSafely(config, {
          role: 'reviewer',
          type: 'agent_notified',
          project,
          mrIid: Number(mergeRequest.iid),
          title: mergeRequest.title ?? null,
          headSha: mergeRequest.sha ?? null,
          threadId: agent.threadId ?? null,
          summary: `已通知 ${agent.label ?? agent.role} agent`,
        });
      }
    } catch (error) {
      console.error(`通知 agent ${agent.id} 失败: ${error.message}`);
      if (!options.dryRun) {
        await recordWatchEventSafely(config, {
          role: 'reviewer',
          type: 'error',
          level: 'error',
          project,
          mrIid: Number(mergeRequest.iid),
          summary: `通知 agent ${agent.id} 失败: ${error.message}`,
        });
      }
    }
  }

  return notifiedCount;
}

function createEmptyState() {
  return {
    version: 1,
    projects: {},
  };
}

function getStatePath(role) {
  return resolve(dataDir, `state-${role}.json`);
}

async function loadState(statePath) {
  try {
    const rawState = await readFile(statePath, 'utf8');
    const state = JSON.parse(rawState);
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('状态文件内容不是对象');
    }
    if (state.projects === null || typeof state.projects !== 'object' || Array.isArray(state.projects)) {
      state.projects = {};
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return createEmptyState();
    }
    throw new Error(`读取状态文件失败: ${error.message}`);
  }
}

async function saveState(statePath, state) {
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, statePath);
}

function getMergeRequestState(state, project, mergeRequestIid) {
  return state.projects?.[project]?.[String(mergeRequestIid)] ?? null;
}

function setMergeRequestState(state, project, mergeRequestIid, mergeRequestState) {
  if (!state.projects[project]) {
    state.projects[project] = {};
  }
  state.projects[project][String(mergeRequestIid)] = mergeRequestState;
}

async function recordWatchEvent(config, event) {
  await mkdir(dirname(config.watchEventLogPathResolved), { recursive: true });
  await appendFile(
    config.watchEventLogPathResolved,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`,
    'utf8',
  );
}

async function recordWatchEventSafely(config, event) {
  try {
    await recordWatchEvent(config, event);
  } catch (error) {
    console.error(`写入管理页面事件日志失败: ${error.message}`);
  }
}

async function readWatchEvents(config, limit) {
  try {
    const rawEvents = await readFile(config.watchEventLogPathResolved, 'utf8');
    const events = rawEvents
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((event) => event !== null);

    return events.reverse();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function shouldNotifyReviewer(previousState, mergeRequest, newNotesText) {
  if (previousState.headSha !== (mergeRequest.sha ?? null)) {
    return true;
  }
  if (newNotesText.length > 0) {
    return true;
  }
  const currentMergeStatus = mergeRequest.detailed_merge_status ?? null;
  if (
    previousState.mergeStatus !== currentMergeStatus
    && REVIEW_ATTENTION_MERGE_STATUSES.has(currentMergeStatus)
  ) {
    return true;
  }

  const currentPipelineStatus = mergeRequest.head_pipeline?.status ?? null;
  return previousState.pipelineStatus !== currentPipelineStatus
    && TERMINAL_PIPELINE_STATUSES.has(currentPipelineStatus);
}

function shouldNotifyDeveloper(previousState, mergeRequest, newNotesText) {
  if (newNotesText.length > 0) {
    return true;
  }

  const currentPipelineStatus = mergeRequest.head_pipeline?.status ?? null;
  if (
    previousState.pipelineStatus !== currentPipelineStatus
    && TERMINAL_PIPELINE_STATUSES.has(currentPipelineStatus)
  ) {
    return true;
  }

  const currentMergeStatus = mergeRequest.detailed_merge_status ?? null;
  return previousState.mergeStatus !== currentMergeStatus
    && ATTENTION_MERGE_STATUSES.has(currentMergeStatus);
}

async function pollReviewer(config, state, runtime, options) {
  let queuedCount = 0;
  let checkedCount = 0;

  for (const projectConfig of config.projects) {
    const project = getProjectPath(projectConfig);
    const openMergeRequests = await listAllOpenMergeRequests(runtime.gitlab, project);

    for (const listMergeRequest of openMergeRequests) {
      try {
        const mergeRequest = await runtime.gitlab.viewMergeRequest(project, listMergeRequest.iid);
        const reviewerIgnoredAuthors = new Set(runtime.ignoredAuthors);
        if (mergeRequest.author?.username === runtime.currentUser) {
          reviewerIgnoredAuthors.delete(runtime.currentUser);
        }
        const watchedNotes = collectWatchedNotes(mergeRequest, reviewerIgnoredAuthors);
        const latestWatchedNoteId = latestNoteId(watchedNotes);
        const fingerprint = buildReviewerFingerprint(mergeRequest, latestWatchedNoteId);
        const previousState = getMergeRequestState(state, project, mergeRequest.iid);
        const reviewThreadId = getReviewThreadId(config, project, mergeRequest.iid);
        checkedCount += 1;

        if (!previousState) {
          let queuedThreadId = null;
          let eventType = null;
          let eventSummary = null;

          if (!reviewThreadId) {
            if (options.dryRun) {
              console.log('\n[DRY-RUN] 将创建审查线程');
              console.log(buildReviewThreadTitle(project, mergeRequest));
              console.log(buildReviewPrompt(project, mergeRequest, projectConfig));
              console.log('');
            } else {
              const createdThread = await runtime.appServer.createReviewThread({
                cwd: getProjectWorkspace(projectConfig) ?? serviceHome,
                title: buildReviewThreadTitle(project, mergeRequest),
                prompt: buildReviewPrompt(project, mergeRequest, projectConfig),
                developerInstructions: REVIEW_THREAD_INSTRUCTIONS,
                model: config.reviewModel,
                effort: config.reviewEffort,
              });
              await persistReviewThreadMapping(config, project, mergeRequest.iid, createdThread.threadId);
              queuedThreadId = createdThread.threadId;
              queuedCount += 1;
              eventType = 'thread_created';
              eventSummary = '发现新 MR，已创建独立审查线程';
            }
          } else if (config.notifyOnStart) {
            const message = buildReviewerUpdateMessage(project, mergeRequest, null, '');
            await queueThreadMessage(reviewThreadId, message, options);
            queuedCount += 1;
            queuedThreadId = reviewThreadId;
            eventType = 'review_started';
            eventSummary = '按配置对已有映射发起启动检查';
          }

          if (!options.dryRun && eventType) {
            await recordWatchEventSafely(config, {
              role: 'reviewer',
              type: eventType,
              project,
              mrIid: Number(mergeRequest.iid),
              title: mergeRequest.title ?? null,
              headSha: mergeRequest.sha ?? null,
              threadId: queuedThreadId,
              summary: eventSummary,
            });
            await notifyRegisteredAgents(
              config,
              project,
              mergeRequest,
              eventType,
              '',
              options,
              new Set(queuedThreadId ? [queuedThreadId] : []),
            );
          }

          if (!options.dryRun) {
            setMergeRequestState(
              state,
              project,
              mergeRequest.iid,
              buildMergeRequestState(mergeRequest, fingerprint, latestWatchedNoteId),
            );
          }
          continue;
        }

        if (previousState.fingerprint === fingerprint) {
          refreshMergeRequestMetadata(previousState, mergeRequest);
          continue;
        }

        const newNotesText = formatNewNotes(watchedNotes, previousState.latestWatchedNoteId);
        if (!reviewThreadId) {
          if (options.dryRun) {
            console.log('\n[DRY-RUN] MR 缺少映射，将创建审查线程');
            console.log(buildReviewThreadTitle(project, mergeRequest));
            console.log(buildReviewPrompt(project, mergeRequest, projectConfig));
            console.log('');
          } else {
            const createdThread = await runtime.appServer.createReviewThread({
              cwd: getProjectWorkspace(projectConfig) ?? serviceHome,
              title: buildReviewThreadTitle(project, mergeRequest),
              prompt: buildReviewPrompt(project, mergeRequest, projectConfig),
              developerInstructions: REVIEW_THREAD_INSTRUCTIONS,
              model: config.reviewModel,
              effort: config.reviewEffort,
            });
            await persistReviewThreadMapping(config, project, mergeRequest.iid, createdThread.threadId);
            queuedCount += 1;
            await recordWatchEventSafely(config, {
              role: 'reviewer',
              type: 'thread_created',
              project,
              mrIid: Number(mergeRequest.iid),
              title: mergeRequest.title ?? null,
              headSha: mergeRequest.sha ?? null,
              threadId: createdThread.threadId,
              summary: 'MR 缺少审查线程映射，已自动创建',
            });
            await notifyRegisteredAgents(
              config,
              project,
              mergeRequest,
              'thread_created',
              newNotesText,
              options,
              new Set([createdThread.threadId]),
            );
          }
        } else if (shouldNotifyReviewer(previousState, mergeRequest, newNotesText)) {
          const message = buildReviewerUpdateMessage(project, mergeRequest, previousState, newNotesText);
          await queueThreadMessage(reviewThreadId, message, options);
          queuedCount += 1;

          if (!options.dryRun) {
            await recordWatchEventSafely(config, {
              role: 'reviewer',
              type: 'mr_update',
              project,
              mrIid: Number(mergeRequest.iid),
              title: mergeRequest.title ?? null,
              headSha: mergeRequest.sha ?? null,
              threadId: reviewThreadId,
              summary: newNotesText.length > 0
                ? 'MR 有新讨论，已通知审查线程'
                : 'MR 的提交、pipeline 或合并状态变化，已通知审查线程',
            });
            await notifyRegisteredAgents(
              config,
              project,
              mergeRequest,
              'mr_update',
              newNotesText,
              options,
              new Set([reviewThreadId]),
            );
          }
        }

        if (!options.dryRun) {
          setMergeRequestState(
            state,
            project,
            mergeRequest.iid,
            buildMergeRequestState(mergeRequest, fingerprint, latestWatchedNoteId),
          );
        }
      } catch (error) {
        console.error(`[${project}!${listMergeRequest.iid}] ${error.message}`);
        if (!options.dryRun) {
          await recordWatchEventSafely(config, {
            role: 'reviewer',
            type: 'error',
            level: 'error',
            project,
            mrIid: Number(listMergeRequest.iid),
            summary: error.message,
          });
        }
      }
    }
  }

  console.log(
    `[${new Date().toISOString()}] 审核端：检查 ${checkedCount} 个 MR，投递 ${queuedCount} 条`,
  );
}

async function pollDeveloper(config, state, runtime, options) {
  let queuedCount = 0;
  let checkedCount = 0;
  const configuredIids = config.developer.watchMergeRequests.map((iid) => Number(iid));

  for (const projectConfig of config.projects) {
    const project = getProjectPath(projectConfig);
    const openMergeRequests = await listAllOpenMergeRequests(runtime.gitlab, project);
    const watchedMergeRequests = configuredIids.length > 0
      ? openMergeRequests.filter((mergeRequest) => configuredIids.includes(Number(mergeRequest.iid)))
      : openMergeRequests.filter((mergeRequest) => mergeRequest.author?.username === runtime.currentUser);

    for (const listMergeRequest of watchedMergeRequests) {
      try {
        const mergeRequest = await runtime.gitlab.viewMergeRequest(project, listMergeRequest.iid);
        const watchedNotes = collectWatchedNotes(mergeRequest, runtime.ignoredAuthors);
        const latestWatchedNoteId = latestNoteId(watchedNotes);
        const fingerprint = buildDeveloperFingerprint(mergeRequest, latestWatchedNoteId);
        const previousState = getMergeRequestState(state, project, mergeRequest.iid);
        checkedCount += 1;

        if (!previousState) {
          if (!options.dryRun) {
            setMergeRequestState(
              state,
              project,
              mergeRequest.iid,
              buildMergeRequestState(mergeRequest, fingerprint, latestWatchedNoteId),
            );
          }
          continue;
        }

        if (previousState.fingerprint === fingerprint) {
          refreshMergeRequestMetadata(previousState, mergeRequest);
          continue;
        }

        const newNotesText = formatNewNotes(watchedNotes, previousState.latestWatchedNoteId);
        if (shouldNotifyDeveloper(previousState, mergeRequest, newNotesText)) {
          const message = buildDeveloperMessage(project, mergeRequest, previousState, newNotesText);
          const notifiedThreads = await deliverDeveloperMessage(project, mergeRequest, message, runtime, options);
          queuedCount += 1;

          if (!options.dryRun) {
            await recordWatchEventSafely(config, {
              role: 'developer',
              type: 'developer_notify',
              project,
              mrIid: Number(mergeRequest.iid),
              title: mergeRequest.title ?? null,
              headSha: mergeRequest.sha ?? null,
              threadId: notifiedThreads[0] ?? null,
              summary: newNotesText.length > 0
                ? 'MR 有新审查意见，已通知开发 agent'
                : 'MR 的 CI 或合并状态需要处理，已通知开发 agent',
            });
          }
        }

        if (!options.dryRun) {
          setMergeRequestState(
            state,
            project,
            mergeRequest.iid,
            buildMergeRequestState(mergeRequest, fingerprint, latestWatchedNoteId),
          );
        }
      } catch (error) {
        console.error(`[${project}!${listMergeRequest.iid}] ${error.message}`);
        if (!options.dryRun) {
          await recordWatchEventSafely(config, {
            role: 'developer',
            type: 'error',
            level: 'error',
            project,
            mrIid: Number(listMergeRequest.iid),
            summary: error.message,
          });
        }
      }
    }
  }

  console.log(
    `[${new Date().toISOString()}] 开发者端：检查 ${checkedCount} 个 MR，投递 ${queuedCount} 条`,
  );
}

async function refreshRuntime(config, runtime) {
  const token = config.gitlabHost ? await resolveGitLabToken(serviceHome, config.gitlabHost) : null;
  const key = JSON.stringify([config.gitlabHost, token, config.projects]);
  if (runtime.clientKey !== key) {
    runtime.clientKey = key;
    runtime.authHost = config.gitlabHost;
    runtime.authErrors = [];
    runtime.clients = new Map();
    runtime.currentUser = null;
    runtime.gitlab = null;
    let tokenClient = null;
    let tokenUser = null;
    if (config.gitlabHost && token) {
      tokenClient = new TokenGitLabClient({ host: config.gitlabHost, token });
      try { tokenUser = await tokenClient.currentUser(); } catch (error) {
        runtime.authErrors.push(error.message);
      }
      runtime.gitlab = tokenClient;
      runtime.currentUser = tokenUser;
    }
    for (const project of config.projects) {
      const gitlab = tokenClient || await createGitLabClient({ serviceHome, config, project });
      if (!gitlab) continue;
      try {
        const currentUser = tokenClient ? tokenUser : await gitlab.currentUser();
        if (!currentUser) continue;
        runtime.clients.set(project.path, { gitlab, currentUser });
        runtime.currentUser ||= currentUser;
        runtime.gitlab ||= gitlab;
      } catch (error) {
        runtime.authErrors.push(`${project.path}: ${error.message}`);
        console.error(`[${project.path}] GitLab 认证失败: ${error.message}`);
      }
    }
  }
  if (runtime.authErrors?.length) runtime.clientKey = null;
  if (runtime.appServer?.url !== config.appServerUrl) {
    runtime.appServer?.close();
    runtime.appServer = createAppServerClient({ url: config.appServerUrl, cwd: serviceHome });
  }
  runtime.developerThreadId = runtime.options.thread || config.developerThreadId || null;
}

async function deliverDeveloperMessage(project, mergeRequest, message, runtime, options) {
  const agents = (await listAgents(serviceHome)).filter((agent) =>
    agent.role === 'developer' && agentMatches(agent, project, mergeRequest.iid));
  if (!agents.length) {
    if (!runtime.developerThreadId) throw new Error(`项目 ${project} 没有匹配的 developer agent 或默认 thread`);
    await queueThreadMessage(runtime.developerThreadId, message, options);
    return [runtime.developerThreadId];
  }
  const sent = new Set();
  for (const agent of agents) {
    if (agent.threadId && !sent.has(agent.threadId)) {
      await queueThreadMessage(agent.threadId, message, options);
      sent.add(agent.threadId);
    }
    if (agent.hookUrl) {
      if (options.dryRun) console.log(`[DRY-RUN] POST hook ${agent.hookUrl}\n${message}`);
      else await postAgentHook(agent, {
        event: 'developer_notify', project, mrIid: Number(mergeRequest.iid), message,
        timestamp: new Date().toISOString(),
      });
    }
  }
  return [...sent];
}

async function pollOnce(role, state, runtime, options) {
  const config = applyOptions(await loadConfigSafely(), options);
  await refreshRuntime(config, runtime);
  const errors = [...(runtime.authErrors || [])];
  for (const project of config.projects) {
    try {
      // Re-read between projects so removals take effect even during a long poll.
      const latest = applyOptions(await loadConfigSafely(), options);
      const active = latest.projects.find((item) => item.path === project.path);
      if (!active) continue;
      const client = runtime.clients.get(project.path);
      if (!client) continue;
      const projectRuntime = {
        ...runtime, ...client,
        ignoredAuthors: new Set([client.currentUser, ...latest.ignoreAuthors]),
      };
      const projectConfig = { ...latest, projects: [active] };
      if (role === 'reviewer') await pollReviewer(projectConfig, state, projectRuntime, options);
      else await pollDeveloper(projectConfig, state, projectRuntime, options);
    } catch (error) {
      errors.push(`${project.path}: ${error.message}`);
      console.error(`[${project.path}] ${error.message}`);
      await recordWatchEventSafely(config, {
        role, type: 'error', level: 'error', project: project.path, summary: error.message,
      });
    }
  }
  runtimeStatus.lastError = errors.join('; ') || null;
  if (!options.dryRun) await saveState(getStatePath(role), state);
  return options.intervalMs ?? config.pollIntervalMs;
}

async function notifyOnce(config, runtime, options) {
  await refreshRuntime(config, runtime);
  const parts = options.notify.split('!');
  let project;
  const iid = Number(parts.at(-1));
  if (parts.length === 2) project = parts[0];
  else if (config.projects.length === 1) project = getProjectPath(config.projects[0]);
  else throw new Error('多项目或零项目下纯 IID 必须同时指定 --project，或使用 project/path!IID');
  if (!config.projects.some((item) => item.path === project)) throw new Error(`项目未配置: ${project}`);
  const client = runtime.clients.get(project);
  if (!client) throw new Error(`项目 ${project} 尚未认证或未配置 GitLab host`);
  const mergeRequest = await client.gitlab.viewMergeRequest(project, iid);
  const notifiedThreads = await deliverDeveloperMessage(project, mergeRequest,
    buildManualDeveloperMessage(project, mergeRequest), runtime, options);
  if (!options.dryRun) await recordWatchEventSafely(config, {
    role: 'developer', type: 'developer_manual', project, mrIid: iid,
    threadId: notifiedThreads[0] ?? null,
    title: mergeRequest.title ?? null, headSha: mergeRequest.sha ?? null,
    summary: '用户手动通知开发 agent 继续处理',
  });
}

function buildMappingRows(config) {
  return Object.entries(config.reviewThreads)
    .map(([key, threadId]) => {
      const separatorIndex = key.lastIndexOf('!');
      const project = separatorIndex >= 0 ? key.slice(0, separatorIndex) : key;
      const mergeRequestIid = separatorIndex >= 0 ? Number(key.slice(separatorIndex + 1)) : 0;
      return {
        key,
        project,
        mrIid: mergeRequestIid,
        threadId,
      };
    })
    .sort((leftMapping, rightMapping) => {
      const projectOrder = leftMapping.project.localeCompare(rightMapping.project);
      return projectOrder !== 0 ? projectOrder : leftMapping.mrIid - rightMapping.mrIid;
    });
}

async function buildGitLabAuthState(context) {
  const config = await loadConfigSafely();
  const host = config.gitlabHost;
  const credentialInfo = await getGitLabCredentialInfo(serviceHome, host);
  const authenticated = Boolean(context.runtime.currentUser) && context.runtime.authHost === host;
  return {
    authenticated,
    currentUser: authenticated ? context.runtime.currentUser : null,
    mode: context.runtime.gitlab?.mode ?? 'none',
    host, webUrl: host,
    tokenSettingsUrl: host ? buildGitLabTokenSettingsUrl(host) : null,
    credentialsSource: credentialInfo.source,
    credentialsUpdatedAt: credentialInfo.updatedAt,
    managedByEnvironment: credentialInfo.source === 'environment',
    needsAuthentication: !authenticated,
  };
}

async function authenticateGitLab(context, token, hostInput) {
  const environmentToken = process.env.GITLAB_TOKEN?.trim();
  const effectiveToken = environmentToken || token;
  if (typeof effectiveToken !== 'string' || !effectiveToken.trim() || effectiveToken.length > 4096) throw new Error('Token 为空或长度异常');
  const config = await loadConfigFromDisk();
  const host = normalizeGitLabHost(hostInput || config.gitlabHost);
  if (!host) throw new Error('请先配置 GitLab host');
  if (config.projects.length && config.gitlabHost && host !== config.gitlabHost) {
    throw new Error('已有项目时不能切换 GitLab host，请先删除项目');
  }
  const gitlab = new TokenGitLabClient({ host, token: effectiveToken.trim() });
  const currentUser = await gitlab.currentUser();
  await mutateConfig(async (latest) => {
    if (latest.projects.length && latest.gitlabHost && host !== latest.gitlabHost) throw new Error('项目 host 已变更，请重试');
    if (!environmentToken) await saveGitLabToken({ serviceHome, host, token: effectiveToken });
    latest.gitlabHost = host;
  });
  context.runtime.clientKey = null;
  context.runtime.currentUser = currentUser;
  context.runtime.gitlab = gitlab;
  context.runtime.authHost = host;
  context.runtime.authVersion += 1;
  runtimeStatus.lastError = null;
  await recordWatchEventSafely(config, {
    role: context.role, type: 'gitlab_authenticated',
    summary: `已通过 GitLab Token 连接，当前用户 ${currentUser}`,
  });
  return currentUser;
}

function buildActiveMergeRequests(config, roleStates, agents) {
  const activeMergeRequests = [];
  const staleAfterMs = Math.max(config.pollIntervalMs * 3, 180_000);

  for (const [role, state] of Object.entries(roleStates)) {
    for (const [project, mergeRequests] of Object.entries(state.projects ?? {})) {
      if (!config.projects.some((item) => item.path === project)) continue;
      for (const [mergeRequestIid, stateEntry] of Object.entries(mergeRequests)) {
        const key = `${project}!${mergeRequestIid}`;
        const developerAgents = agents.filter((agent) => agent.role === 'developer'
          && agentMatches(agent, project, mergeRequestIid));
        const developerThreadId = developerAgents.length
          ? developerAgents.find((agent) => agent.threadId)?.threadId ?? null
          : config.developerThreadId || null;
        const threadId = role === 'developer' ? developerThreadId : config.reviewThreads[key] ?? null;
        const lastSeenTimestamp = Date.parse(stateEntry.lastSeenAt ?? stateEntry.updatedAt ?? '');
        const isStale = !Number.isFinite(lastSeenTimestamp)
          || Date.now() - lastSeenTimestamp > staleAfterMs;

        activeMergeRequests.push({
          role,
          project,
          mrIid: Number(mergeRequestIid),
          key,
          title: stateEntry.title ?? `MR !${mergeRequestIid}`,
          author: stateEntry.author ?? null,
          headSha: stateEntry.headSha ?? null,
          pipelineStatus: stateEntry.pipelineStatus ?? null,
          mergeStatus: stateEntry.mergeStatus ?? null,
          sourceBranch: stateEntry.sourceBranch ?? null,
          targetBranch: stateEntry.targetBranch ?? null,
          webUrl: stateEntry.webUrl ?? null,
          threadId,
          updatedAt: stateEntry.updatedAt ?? null,
          lastSeenAt: stateEntry.lastSeenAt ?? null,
          isStale,
        });
      }
    }
  }

  return activeMergeRequests.sort((leftMergeRequest, rightMergeRequest) => {
    const leftTimestamp = Date.parse(leftMergeRequest.lastSeenAt ?? leftMergeRequest.updatedAt ?? '');
    const rightTimestamp = Date.parse(rightMergeRequest.lastSeenAt ?? rightMergeRequest.updatedAt ?? '');
    return (Number.isFinite(rightTimestamp) ? rightTimestamp : 0)
      - (Number.isFinite(leftTimestamp) ? leftTimestamp : 0);
  });
}

async function buildDashboardOverview(context) {
  const config = await loadConfigSafely();
  const otherRole = context.role === 'reviewer' ? 'developer' : 'reviewer';
  const otherRoleState = await loadState(getStatePath(otherRole));
  const agents = await listAgents(serviceHome);
  const activeMergeRequests = buildActiveMergeRequests({ ...config, developerThreadId: context.runtime.developerThreadId }, {
    [context.role]: context.state,
    [otherRole]: otherRoleState,
  }, agents);
  const events = await readWatchEvents(config, 200);

  return {
    generatedAt: new Date().toISOString(),
    status: {
      ...runtimeStatus,
      role: context.role,
      pollIntervalMs: context.options.intervalMs ?? config.pollIntervalMs,
    },
    auth: await buildGitLabAuthState(context),
    config: {
      projects: config.projects,
      gitlabHost: config.gitlabHost,
      serviceHome,
      appServerUrl: config.appServerUrl,
      developerThreadId: config.developerThreadId ?? null,
      pollIntervalMs: config.pollIntervalMs,
      notifyOnStart: Boolean(config.notifyOnStart),
      dashboardHost: config.dashboardHost,
      dashboardPort: config.dashboardPort,
      watchEventLogPath: config.watchEventLogPath,
    },
    mappings: buildMappingRows(config),
    agents,
    activeMergeRequests,
    events,
    stats: {
      projectCount: config.projects.length,
      activeCount: activeMergeRequests.filter((mergeRequest) => !mergeRequest.isStale).length,
      mappingCount: Object.keys(config.reviewThreads).length,
      eventCount: events.length,
      agentCount: agents.length,
      pollIntervalMs: context.options.intervalMs ?? config.pollIntervalMs,
    },
  };
}

function sendDashboardJson(response, statusCode, body) {
  const json = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  response.end(json);
}

async function sendDashboardFile(response, fileName, contentType) {
  const content = await readFile(resolve(packageRoot, fileName));
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': content.length,
    'cache-control': 'no-store',
  });
  response.end(content);
}

async function readJsonRequestBody(request, maxBytes = 256 * 1024) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new Error('请求体过大');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function updateMapping(context, key, threadId) {
  if (typeof key !== 'string' || !/^[^!]+!\d+$/.test(key)) {
    throw new Error('映射键格式应为 项目路径!MR IID');
  }
  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw new Error('threadId 不能为空');
  }

  await mutateConfig((config) => { config.reviewThreads[key] = threadId.trim(); });
  const config = await loadConfigFromDisk();

  const project = key.slice(0, key.lastIndexOf('!'));
  const mergeRequestIid = Number(key.slice(key.lastIndexOf('!') + 1));
  await recordWatchEventSafely(config, {
    role: context.role,
    type: 'mapping_added',
    project,
    mrIid: mergeRequestIid,
    threadId: threadId.trim(),
    summary: '管理页面新增或更新审查线程映射',
  });
}

async function removeMapping(context, key) {
  let threadId;
  await mutateConfig((config) => {
    if (!Object.hasOwn(config.reviewThreads, key)) throw new Error('映射不存在');
    threadId = config.reviewThreads[key];
    delete config.reviewThreads[key];
  });
  const config = await loadConfigFromDisk();

  const project = key.slice(0, key.lastIndexOf('!'));
  const mergeRequestIid = Number(key.slice(key.lastIndexOf('!') + 1));
  await recordWatchEventSafely(config, {
    role: context.role,
    type: 'mapping_removed',
    project,
    mrIid: mergeRequestIid,
    threadId,
    summary: '管理页面删除审查线程映射',
  });
}

async function handleDashboardRequest(request, response, context) {
  const requestUrl = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? '127.0.0.1'}`,
  );

  if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
    sendDashboardJson(response, 200, {
      ok: true,
      role: context.role,
      uptimeSeconds: Math.floor(process.uptime()),
    });
    return;
  }

  if (requestUrl.pathname === '/api/projects') {
    try {
      if (request.method === 'GET') {
        const config = await loadConfigSafely();
        sendDashboardJson(response, 200, { projects: config.projects, gitlabHost: config.gitlabHost });
      } else if (request.method === 'POST') {
        const body = await readJsonRequestBody(request);
        await mutateConfig((config) => { prepareProject(config, body); });
        context.runtime.authVersion += 1;
        sendDashboardJson(response, 201, await buildDashboardOverview(context));
      } else if (request.method === 'DELETE') {
        const path = requestUrl.searchParams.get('path');
        await mutateConfig((config) => {
          if (!config.projects.some((project) => project.path === path)) throw new Error('项目不存在');
          config.projects = config.projects.filter((project) => project.path !== path);
        });
        context.runtime.authVersion += 1;
        sendDashboardJson(response, 200, await buildDashboardOverview(context));
      } else sendDashboardJson(response, 405, { error: 'method_not_allowed' });
    } catch (error) {
      sendDashboardJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/overview') {
    sendDashboardJson(response, 200, await buildDashboardOverview(context));
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/auth/status') {
    sendDashboardJson(response, 200, await buildGitLabAuthState(context));
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/gitlab') {
    try {
      const body = await readJsonRequestBody(request);
      const currentUser = await authenticateGitLab(context, body.token, body.host);
      sendDashboardJson(response, 200, {
        currentUser,
        ...(await buildDashboardOverview(context)),
      });
    } catch (error) {
      sendDashboardJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/mappings') {
    try {
      const body = await readJsonRequestBody(request);
      await updateMapping(context, body.key, body.threadId);
      sendDashboardJson(response, 200, await buildDashboardOverview(context));
    } catch (error) {
      sendDashboardJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === 'DELETE' && requestUrl.pathname === '/api/mappings') {
    try {
      await removeMapping(context, requestUrl.searchParams.get('key'));
      sendDashboardJson(response, 200, await buildDashboardOverview(context));
    } catch (error) {
      sendDashboardJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/dashboard.html')) {
    await sendDashboardFile(response, 'dashboard.html', 'text/html; charset=utf-8');
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/dashboard.css') {
    await sendDashboardFile(response, 'dashboard.css', 'text/css; charset=utf-8');
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/dashboard.js') {
    await sendDashboardFile(response, 'dashboard.js', 'text/javascript; charset=utf-8');
    return;
  }

  if (request.url === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  sendDashboardJson(response, 404, { error: 'not_found' });
}

async function startDashboard(context) {
  if (context.options.noDashboard) {
    return null;
  }

  const config = await loadConfigSafely();
  const host = context.options.dashboardHost ?? config.dashboardHost ?? DEFAULT_DASHBOARD_HOST;
  const port = context.options.dashboardPort ?? config.dashboardPort ?? DEFAULT_DASHBOARD_PORT;
  const server = createHttpServer((request, response) => {
    handleDashboardRequest(request, response, context).catch((error) => {
      console.error('管理页面请求失败:', error);
      if (!response.headersSent) {
        sendDashboardJson(response, 500, { error: 'internal_error' });
      }
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    const handleError = (error) => {
      server.off('listening', handleListening);
      rejectListen(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolveListen();
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, host);
  });

  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  runtimeStatus.dashboardUrl = `http://${displayHost}:${port}`;
  console.log(`管理页面: ${runtimeStatus.dashboardUrl}`);
  return server;
}

function sleep(milliseconds, shouldStop, shouldWake = () => false) {
  return new Promise((resolveSleep) => {
    if (shouldStop() || shouldWake()) {
      resolveSleep();
      return;
    }

    const finish = () => {
      clearInterval(interval);
      clearTimeout(timer);
      resolveSleep();
    };

    const timer = setTimeout(finish, milliseconds);

    const interval = setInterval(() => {
      if (shouldStop() || shouldWake()) {
        finish();
      }
    }, 500);
  });
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const config = applyOptions(await loadConfigSafely(), options, true);
  const role = await resolveRole(options, config);
  const runtime = {
    options, currentUser: null, gitlab: null, clients: new Map(),
    clientKey: null, authHost: null, authVersion: 0, appServer: null,
    developerThreadId: options.thread || config.developerThreadId || null,
  };
  let intervalMs = options.intervalMs ?? config.pollIntervalMs;
  const statePath = getStatePath(role);
  await mkdir(dataDir, { recursive: true });
  const state = await loadState(statePath);
  const dashboardContext = {
    role,
    state,
    runtime,
    options,
  };
  let shouldStop = false;
  let dashboardServer = null;

  process.on('SIGINT', () => {
    shouldStop = true;
    console.log('收到 SIGINT，当前轮询结束后退出...');
  });
  process.on('SIGTERM', () => {
    shouldStop = true;
    console.log('收到 SIGTERM，当前轮询结束后退出...');
  });

  runtimeStatus.role = role;
  runtimeStatus.startedAt = new Date().toISOString();

  console.log(`GitLab MR 自动跟进已启动，角色: ${role}`);
  console.log(`服务目录: ${serviceHome}`);
  console.log(`GitLab: ${config.gitlabHost || '未配置'}`);
  console.log(`项目: ${config.projects.map(getProjectPath).join(', ') || '暂无项目'}`);
  console.log(`状态文件: ${statePath}`);
  console.log(`配置: ${configPath}`);

  if (options.notify !== null) {
    try { await notifyOnce(config, runtime, options); }
    finally { runtime.appServer?.close(); }
    return;
  }

  try {
    dashboardServer = await startDashboard(dashboardContext);
  } catch (error) {
    console.error(`管理页面启动失败: ${error.message}`);
  }

  // Watch atomic config/credential replacements, including edits made by a separate CLI.
  const watchers = [];
  for (const directory of new Set([dirname(configPath), serviceHome])) {
    watchers.push(watchDirectory(directory, (event, file) => {
      const name = String(file ?? '');
      if ((directory === dirname(configPath) && name === basename(configPath))
          || (directory === serviceHome && name === 'credentials.json')) runtime.authVersion += 1;
    }));
  }

  await recordWatchEventSafely(config, {
    role,
    type: 'watcher_started',
    summary: `以 ${role} 角色启动自动跟进`,
  });

  try {
    while (!shouldStop) {
      const wakeVersion = runtime.authVersion;
      const startedAt = Date.now();
      runtimeStatus.isPolling = true;
      runtimeStatus.lastPollAt = new Date().toISOString();

      try {
        intervalMs = await pollOnce(role, state, runtime, options);
      } catch (error) {
        runtimeStatus.lastError = error.message;
        console.error(`[${new Date().toISOString()}] 本轮检查失败: ${error.message}`);
        await recordWatchEventSafely(config, {
          role,
          type: 'error',
          level: 'error',
          summary: error.message,
        });
      } finally {
        const finishedAt = Date.now();
        runtimeStatus.isPolling = false;
        runtimeStatus.lastPollFinishedAt = new Date(finishedAt).toISOString();
        runtimeStatus.lastPollDurationMs = finishedAt - startedAt;
        runtimeStatus.nextPollAt = options.once
          ? null
          : new Date(finishedAt + Math.max(0, intervalMs - (finishedAt - startedAt))).toISOString();
      }

      if (options.once || shouldStop) {
        break;
      }

      const elapsedMs = Date.now() - startedAt;
      const waitMs = Math.max(0, intervalMs - elapsedMs);
      if (waitMs > 0) {
        await sleep(waitMs, () => shouldStop, () => runtime.authVersion !== wakeVersion);
      }
    }

    if (!options.dryRun) {
      await saveState(statePath, state);
    }
    await recordWatchEventSafely(config, {
      role,
      type: 'watcher_stopped',
      summary: '自动跟进已停止',
    });
    console.log('GitLab MR 自动跟进已停止');
  } finally {
    runtimeStatus.nextPollAt = null;
    for (const watcher of watchers) watcher.close();
    runtime.appServer?.close();
    if (dashboardServer) {
      await new Promise((resolveClose) => dashboardServer.close(resolveClose));
    }
  }
}

run().catch((error) => {
  console.error(`启动失败: ${error.message}`);
  process.exit(1);
});
