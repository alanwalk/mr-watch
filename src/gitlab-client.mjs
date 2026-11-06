import { execFileSync } from 'node:child_process';

import {
  inferGitLabHost,
  resolveGitLabToken,
} from './workspace.mjs';

const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;

function normalizeHost(host) {
  return String(host).trim().replace(/\/+$/, '');
}

function runCommand(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
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

export class TokenGitLabClient {
  constructor({ host, token }) {
    this.mode = 'token';
    this.host = normalizeHost(host);
    this.token = token;
    this.apiBase = `${this.host}/api/v4`;
  }

  async request(path, query = {}) {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      headers: {
        'PRIVATE-TOKEN': this.token,
        Accept: 'application/json',
        'User-Agent': 'mr-watch/0.1.0',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitLab API ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
    }

    return response.json();
  }

  async currentUser() {
    const user = await this.request('/user');
    if (!user?.username) {
      throw new Error('GitLab /user 没有返回 username');
    }
    return user.username;
  }

  async listOpenMergeRequests(project, page = 1, perPage = PAGE_SIZE) {
    return this.request(`/projects/${encodeURIComponent(project)}/merge_requests`, {
      state: 'opened',
      order_by: 'created_at',
      sort: 'desc',
      per_page: perPage,
      page,
    });
  }

  async listDiscussions(project, mergeRequestIid) {
    const discussions = [];

    for (let page = 1; page <= 10; page += 1) {
      const pageItems = await this.request(
        `/projects/${encodeURIComponent(project)}/merge_requests/${mergeRequestIid}/discussions`,
        {
          per_page: PAGE_SIZE,
          page,
        },
      );
      if (!Array.isArray(pageItems)) {
        throw new Error('GitLab discussions 返回格式不是数组');
      }
      discussions.push(...pageItems);
      if (pageItems.length < PAGE_SIZE) {
        break;
      }
    }

    return discussions;
  }

  async viewMergeRequest(project, mergeRequestIid) {
    const mergeRequest = await this.request(
      `/projects/${encodeURIComponent(project)}/merge_requests/${mergeRequestIid}`,
    );
    const discussions = await this.listDiscussions(project, mergeRequestIid);
    return {
      ...mergeRequest,
      Discussions: discussions,
    };
  }
}

class GlabGitLabClient {
  constructor({ cwd }) {
    this.mode = 'glab';
    this.cwd = cwd;
  }

  runJson(args) {
    const output = runCommand('glab', args, this.cwd).replace(/^\uFEFF/, '');
    try {
      return JSON.parse(output);
    } catch {
      throw new Error(`glab 返回的不是 JSON: ${output.slice(0, 300)}`);
    }
  }

  async currentUser() {
    const user = this.runJson(['api', 'user']);
    if (!user?.username) {
      throw new Error('GitLab /user 没有返回 username');
    }
    return user.username;
  }

  async listOpenMergeRequests(project, page = 1, perPage = PAGE_SIZE) {
    return this.runJson([
      'mr',
      'list',
      '-R',
      project,
      '--output',
      'json',
      '--per-page',
      String(perPage),
      '--page',
      String(page),
    ]);
  }

  async viewMergeRequest(project, mergeRequestIid) {
    return this.runJson([
      'mr',
      'view',
      String(mergeRequestIid),
      '-R',
      project,
      '--comments',
      '--output',
      'json',
    ]);
  }
}

export async function createGitLabClient({ workspaceRoot, config }) {
  const host = normalizeHost(config.gitlabHost || inferGitLabHost(workspaceRoot));
  const token = await resolveGitLabToken(workspaceRoot, host);
  if (token) {
    return new TokenGitLabClient({ host, token });
  }

  return new GlabGitLabClient({ cwd: workspaceRoot });
}
