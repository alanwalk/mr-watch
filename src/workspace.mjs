import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';

export const DEFAULT_APP_SERVER_URL = 'ws://127.0.0.1:18787';
export const DEFAULT_DASHBOARD_PORT = 8787;

export function resolveServiceHome(home = null) {
  return resolve(home || process.env.MR_WATCH_HOME || resolve(homedir(), '.config', 'mr-watch'));
}

export function getDataDir(serviceHome) {
  return serviceHome;
}

export function normalizeGitLabHost(host = '') {
  if (!host) return '';
  const url = new URL(String(host).trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('gitlabHost 必须是 http(s) 服务地址，不能包含路径或认证信息');
  }
  return url.origin;
}

export function getProjectPath(project) {
  return project?.path ?? '';
}

export function getProjectWorkspace(project) {
  return project?.workspace ?? null;
}

export function normalizeProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error('项目必须是包含 path 和可选 workspace 的对象');
  }
  const path = typeof project.path === 'string' ? project.path.trim().replace(/^\/+|\/+$/g, '') : '';
  if (!/^[^\s/!?#\\]+(?:\/[^\s/!?#\\]+)+$/.test(path)
      || path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('path 必须是 GitLab project full path，例如 team/project');
  }
  const workspace = project.workspace == null || project.workspace === '' ? null : project.workspace;
  if (workspace !== null && (typeof workspace !== 'string' || !isAbsolute(workspace))) {
    throw new Error('workspace 必须是本地绝对路径');
  }
  return { path, workspace: workspace === null ? null : resolve(workspace) };
}

export function normalizeProjects(projects) {
  if (!Array.isArray(projects)) throw new Error('projects 必须是数组');
  const normalized = projects.map(normalizeProject);
  if (new Set(normalized.map(getProjectPath)).size !== normalized.length) {
    throw new Error('项目 path 不能重复');
  }
  return normalized;
}

export function prepareProject(config, input) {
  let remote = null;
  if (input.workspace) {
    if (!isAbsolute(input.workspace)) throw new Error('workspace 必须是本地绝对路径');
    try { remote = inferGitLabRemote(input.workspace); } catch (error) {
      if (!input.path) throw error;
    }
  }
  const project = normalizeProject({ ...input, path: input.path || remote?.project });
  if (remote && config.gitlabHost && normalizeGitLabHost(remote.host) !== config.gitlabHost) {
    throw new Error('项目 origin 的 host 与服务 gitlabHost 不一致');
  }
  if (!config.gitlabHost && remote) config.gitlabHost = normalizeGitLabHost(remote.host);
  if (config.projects.some((item) => getProjectPath(item) === project.path)) {
    throw new Error(`项目已存在: ${project.path}`);
  }
  config.projects.push(project);
  return project;
}

export function getConfigPath(serviceHome, configOverride = null) {
  return configOverride
    ? resolve(configOverride)
    : resolve(getDataDir(serviceHome), 'config.json');
}

export function getAgentsPath(serviceHome) {
  return resolve(getDataDir(serviceHome), 'agents.json');
}

export function getStatePath(serviceHome, role) {
  return resolve(getDataDir(serviceHome), `state-${role}.json`);
}

export function getEventLogPath(serviceHome) {
  return resolve(getDataDir(serviceHome), 'events.jsonl');
}

export function getCredentialsPath(serviceHome) {
  return resolve(getDataDir(serviceHome), 'credentials.json');
}

function readOriginRemote(workspaceRoot) {
  return execFileSync(
    'git',
    ['-C', workspaceRoot, 'remote', 'get-url', 'origin'],
    { encoding: 'utf8' },
  ).trim();
}

function parseRemoteUrl(remoteUrl) {
  if (remoteUrl.startsWith('http://') || remoteUrl.startsWith('https://')) {
    const parsedUrl = new URL(remoteUrl);
    return {
      host: `${parsedUrl.protocol}//${parsedUrl.host}`,
      project: decodeURIComponent(
        parsedUrl.pathname
          .replace(/^\/+/, '')
          .replace(/\/+$/, '')
          .replace(/\.git$/, ''),
      ),
    };
  }

  if (remoteUrl.startsWith('ssh://')) {
    const parsedUrl = new URL(remoteUrl);
    return {
      host: `https://${parsedUrl.hostname}`,
      project: decodeURIComponent(
        parsedUrl.pathname
          .replace(/^\/+/, '')
          .replace(/\/+$/, '')
          .replace(/\.git$/, ''),
      ),
    };
  }

  const scpLikeMatch = remoteUrl.match(/^[^@\s]+@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    return {
      host: `https://${scpLikeMatch[1]}`,
      project: scpLikeMatch[2]
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\.git$/, ''),
    };
  }

  throw new Error(`无法从 git remote origin 推断 GitLab 项目: ${remoteUrl}`);
}

export function buildGitLabTokenSettingsUrl(host) {
  const tokenSettingsUrl = new URL(
    '/-/user_settings/personal_access_tokens',
    `${String(host).trim().replace(/\/+$/, '')}/`,
  );
  tokenSettingsUrl.searchParams.set('name', 'mr-watch');
  tokenSettingsUrl.searchParams.set('scopes', 'read_api');
  return tokenSettingsUrl.toString();
}

export function inferGitLabRemote(workspaceRoot) {
  const remote = parseRemoteUrl(readOriginRemote(workspaceRoot));
  return {
    host: remote.host,
    project: remote.project,
    webUrl: `${remote.host}/${remote.project}`,
    tokenSettingsUrl: buildGitLabTokenSettingsUrl(remote.host),
  };
}

export function inferGitLabProject(workspaceRoot) {
  return parseRemoteUrl(readOriginRemote(workspaceRoot)).project;
}

export function inferGitLabHost(workspaceRoot) {
  return parseRemoteUrl(readOriginRemote(workspaceRoot)).host;
}

export function createDefaultConfig() {
  return {
    version: 2,
    role: 'reviewer',
    gitlabHost: '',
    projects: [],
    developerThreadId: '',
    pollIntervalMs: 60_000,
    appServerUrl: DEFAULT_APP_SERVER_URL,
    reviewModel: '',
    reviewEffort: '',
    dashboardHost: '127.0.0.1',
    dashboardPort: DEFAULT_DASHBOARD_PORT,
    watchEventLogPath: 'events.jsonl',
    notifyOnStart: false,
    ignoreAuthors: [],
    reviewThreads: {},
    developer: {
      watchMergeRequests: [],
    },
  };
}

export async function ensureDataDir(serviceHome) {
  const dataDir = getDataDir(serviceHome);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  return dataDir;
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonFile(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, filePath);
}

export async function loadOrCreateConfig({ serviceHome, configPath }) {
  await ensureDataDir(serviceHome);
  const existingConfig = await readJsonFile(configPath, null);
  if (existingConfig) {
    if (existingConfig.version !== 2) throw new Error('config.json 需要 version: 2');
    existingConfig.projects = normalizeProjects(existingConfig.projects);
    existingConfig.gitlabHost = normalizeGitLabHost(existingConfig.gitlabHost);
    return existingConfig;
  }

  const defaultConfig = createDefaultConfig();
  await writeJsonFile(configPath, defaultConfig);
  return defaultConfig;
}

export async function loadAgentRegistry(serviceHome) {
  await ensureDataDir(serviceHome);
  const registry = await readJsonFile(getAgentsPath(serviceHome), null);
  if (!registry || !Array.isArray(registry.agents)) {
    return {
      version: 1,
      agents: [],
    };
  }
  return registry;
}

export async function saveAgentRegistry(serviceHome, registry) {
  await ensureDataDir(serviceHome);
  await writeJsonFile(getAgentsPath(serviceHome), registry);
}

export async function loadCredentials(serviceHome) {
  await ensureDataDir(serviceHome);
  const credentials = await readJsonFile(getCredentialsPath(serviceHome), null);
  if (!credentials || typeof credentials.hosts !== 'object' || credentials.hosts === null) {
    return {
      version: 1,
      hosts: {},
    };
  }
  return credentials;
}

export async function saveGitLabToken({ serviceHome, host, token }) {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('token 不能为空');
  }

  const normalizedHost = String(host).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(normalizedHost)) {
    throw new Error('host 必须是 http(s) URL');
  }

  const credentials = await loadCredentials(serviceHome);
  credentials.hosts[normalizedHost] = {
    token: token.trim(),
    updatedAt: new Date().toISOString(),
  };
  const credentialsPath = getCredentialsPath(serviceHome);
  await writeJsonFile(credentialsPath, credentials);
  if (process.platform !== 'win32') {
    await chmod(credentialsPath, 0o600);
  }
  return normalizedHost;
}

export async function resolveGitLabToken(serviceHome, host) {
  if (process.env.GITLAB_TOKEN?.trim()) {
    return process.env.GITLAB_TOKEN.trim();
  }

  const credentials = await loadCredentials(serviceHome);
  const normalizedHost = String(host).trim().replace(/\/+$/, '');
  return credentials.hosts[normalizedHost]?.token ?? null;
}

export async function getGitLabCredentialInfo(serviceHome, host) {
  if (process.env.GITLAB_TOKEN?.trim()) {
    return {
      source: 'environment',
      hasToken: true,
      updatedAt: null,
    };
  }

  const credentials = await loadCredentials(serviceHome);
  const normalizedHost = String(host).trim().replace(/\/+$/, '');
  const credential = credentials.hosts[normalizedHost];
  if (credential?.token) {
    return {
      source: 'credentials',
      hasToken: true,
      updatedAt: credential.updatedAt ?? null,
    };
  }

  return {
    source: 'none',
    hasToken: false,
    updatedAt: null,
  };
}

// Serialize read/modify/write across the CLI and running service.
export async function updateConfig({ serviceHome, configPath }, mutate) {
  await mkdir(dirname(configPath), { recursive: true });
  const lock = `${configPath}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    try { await mkdir(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`配置正在被修改或锁未释放: ${lock}`);
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  try {
    const config = await loadOrCreateConfig({ serviceHome, configPath });
    const result = await mutate(config);
    await writeJsonFile(configPath, config);
    return result;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
