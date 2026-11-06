import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const DEFAULT_APP_SERVER_URL = 'ws://127.0.0.1:18787';
export const DEFAULT_DASHBOARD_PORT = 8787;

export function resolveWorkspaceRoot(workspacePath = process.cwd()) {
  let currentDirectory = resolve(workspacePath);

  while (true) {
    if (existsSync(resolve(currentDirectory, '.git'))) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw new Error(`无法从 ${workspacePath} 找到 Git 仓库根目录`);
    }
    currentDirectory = parentDirectory;
  }
}

export function getDataDir(workspaceRoot) {
  return resolve(workspaceRoot, '.mr-watch');
}

export function getConfigPath(workspaceRoot, configOverride = null) {
  return configOverride
    ? resolve(configOverride)
    : resolve(getDataDir(workspaceRoot), 'config.json');
}

export function getAgentsPath(workspaceRoot) {
  return resolve(getDataDir(workspaceRoot), 'agents.json');
}

export function getStatePath(workspaceRoot, role) {
  return resolve(getDataDir(workspaceRoot), `state-${role}.json`);
}

export function getEventLogPath(workspaceRoot) {
  return resolve(getDataDir(workspaceRoot), 'events.jsonl');
}

export function getCredentialsPath(workspaceRoot) {
  return resolve(getDataDir(workspaceRoot), 'credentials.json');
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

function buildGitLabTokenSettingsUrl(host) {
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

export function createDefaultConfig(workspaceRoot) {
  return {
    projects: [inferGitLabProject(workspaceRoot)],
    developerThreadId: '',
    pollIntervalMs: 60_000,
    appServerUrl: DEFAULT_APP_SERVER_URL,
    reviewModel: '',
    reviewEffort: '',
    dashboardHost: '127.0.0.1',
    dashboardPort: DEFAULT_DASHBOARD_PORT,
    watchEventLogPath: './events.jsonl',
    notifyOnStart: false,
    ignoreAuthors: [],
    reviewThreads: {},
    developer: {
      watchMergeRequests: [],
    },
  };
}

export async function ensureDataDir(workspaceRoot) {
  const dataDir = getDataDir(workspaceRoot);
  await mkdir(dataDir, { recursive: true });

  const localIgnorePath = resolve(dataDir, '.gitignore');
  if (!existsSync(localIgnorePath)) {
    await writeFile(localIgnorePath, '*\n', 'utf8');
  }

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
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

export async function loadOrCreateConfig({ workspaceRoot, configPath }) {
  await ensureDataDir(workspaceRoot);
  const existingConfig = await readJsonFile(configPath, null);
  if (existingConfig) {
    return existingConfig;
  }

  const defaultConfig = createDefaultConfig(workspaceRoot);
  await writeJsonFile(configPath, defaultConfig);
  return defaultConfig;
}

export async function loadAgentRegistry(workspaceRoot) {
  await ensureDataDir(workspaceRoot);
  const registry = await readJsonFile(getAgentsPath(workspaceRoot), null);
  if (!registry || !Array.isArray(registry.agents)) {
    return {
      version: 1,
      agents: [],
    };
  }
  return registry;
}

export async function saveAgentRegistry(workspaceRoot, registry) {
  await ensureDataDir(workspaceRoot);
  await writeJsonFile(getAgentsPath(workspaceRoot), registry);
}

export async function loadCredentials(workspaceRoot) {
  await ensureDataDir(workspaceRoot);
  const credentials = await readJsonFile(getCredentialsPath(workspaceRoot), null);
  if (!credentials || typeof credentials.hosts !== 'object' || credentials.hosts === null) {
    return {
      version: 1,
      hosts: {},
    };
  }
  return credentials;
}

export async function saveGitLabToken({ workspaceRoot, host, token }) {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('token 不能为空');
  }

  const normalizedHost = String(host).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(normalizedHost)) {
    throw new Error('host 必须是 http(s) URL');
  }

  const credentials = await loadCredentials(workspaceRoot);
  credentials.hosts[normalizedHost] = {
    token: token.trim(),
    updatedAt: new Date().toISOString(),
  };
  const credentialsPath = getCredentialsPath(workspaceRoot);
  await writeJsonFile(credentialsPath, credentials);
  if (process.platform !== 'win32') {
    await chmod(credentialsPath, 0o600);
  }
  return normalizedHost;
}

export async function resolveGitLabToken(workspaceRoot, host) {
  if (process.env.GITLAB_TOKEN?.trim()) {
    return process.env.GITLAB_TOKEN.trim();
  }

  const credentials = await loadCredentials(workspaceRoot);
  const normalizedHost = String(host).trim().replace(/\/+$/, '');
  return credentials.hosts[normalizedHost]?.token ?? null;
}

export async function getGitLabCredentialInfo(workspaceRoot, host) {
  if (process.env.GITLAB_TOKEN?.trim()) {
    return {
      source: 'environment',
      hasToken: true,
      updatedAt: null,
    };
  }

  const credentials = await loadCredentials(workspaceRoot);
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
