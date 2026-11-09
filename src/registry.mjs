import {
  loadAgentRegistry,
  saveAgentRegistry,
  getProjectPath,
} from './workspace.mjs';

function normalizeProjects(projects, fallbackProjects) {
  const values = Array.isArray(projects) && projects.length > 0
    ? projects
    : fallbackProjects;

  return [...new Set(
    values
      .map((project) => (typeof project === 'string' ? project : getProjectPath(project)).trim().replace(/^\/+|\/+$/g, ''))
      .filter((project) => project.length > 0),
  )];
}

function normalizeMergeRequestIids(mrIids) {
  return [...new Set(
    (Array.isArray(mrIids) ? mrIids : [])
      .map((iid) => Number(iid))
      .filter((iid) => Number.isInteger(iid) && iid > 0),
  )];
}

export function agentMatches(agent, project, mergeRequestIid) {
  const projects = Array.isArray(agent.projects) ? agent.projects : [];
  const mrIids = Array.isArray(agent.mrIids) ? agent.mrIids : [];
  const projectMatches = projects.length === 0 || projects.includes(project);
  const mergeRequestMatches = mrIids.length === 0
    || mrIids.includes(Number(mergeRequestIid));
  return projectMatches && mergeRequestMatches;
}

export async function registerAgent({
  serviceHome,
  config,
  threadId,
  hookUrl,
  role = 'developer',
  projects,
  mrIids,
  label,
}) {
  if (!['developer', 'reviewer'].includes(role)) {
    throw new Error('role 只支持 developer 或 reviewer');
  }
  if (!threadId && !hookUrl) {
    throw new Error('至少需要 --thread 或 --hook-url');
  }
  if (hookUrl) {
    const parsedHookUrl = new URL(hookUrl);
    if (!['http:', 'https:'].includes(parsedHookUrl.protocol)) {
      throw new Error('hookUrl 只支持 http/https');
    }
  }

  const registry = await loadAgentRegistry(serviceHome);
  const normalizedProjects = normalizeProjects(projects, config.projects);
  const normalizedMrIids = normalizeMergeRequestIids(mrIids);
  if (normalizedMrIids.length && config.projects.length !== 1 && !projects?.length) {
    throw new Error('多项目或零项目下 --mr 必须同时指定 --project');
  }
  const now = new Date().toISOString();
  const existingAgent = registry.agents.find((agent) => {
    if (threadId && agent.threadId === threadId) {
      return true;
    }
    return hookUrl && agent.hookUrl === hookUrl;
  });

  if (existingAgent) {
    existingAgent.role = role;
    existingAgent.projects = normalizedProjects;
    existingAgent.mrIids = normalizedMrIids;
    existingAgent.threadId = threadId || null;
    existingAgent.hookUrl = hookUrl || null;
    existingAgent.label = label || existingAgent.label;
    existingAgent.updatedAt = now;
    await saveAgentRegistry(serviceHome, registry);
    return existingAgent;
  }

  const agent = {
    id: `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    projects: normalizedProjects,
    mrIids: normalizedMrIids,
    threadId: threadId || null,
    hookUrl: hookUrl || null,
    label: label || null,
    createdAt: now,
    updatedAt: now,
  };
  registry.agents.push(agent);
  await saveAgentRegistry(serviceHome, registry);
  return agent;
}

export async function unregisterAgent({ serviceHome, id, threadId }) {
  const registry = await loadAgentRegistry(serviceHome);
  const originalCount = registry.agents.length;
  registry.agents = registry.agents.filter((agent) => {
    if (id) {
      return agent.id !== id;
    }
    if (threadId) {
      return agent.threadId !== threadId;
    }
    return true;
  });

  if (registry.agents.length === originalCount) {
    return 0;
  }

  await saveAgentRegistry(serviceHome, registry);
  return originalCount - registry.agents.length;
}

export async function listAgents(serviceHome) {
  const registry = await loadAgentRegistry(serviceHome);
  return registry.agents;
}
