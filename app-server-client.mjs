import { spawn } from 'node:child_process';

const CONNECT_TIMEOUT_MS = 1_500;
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

export class AppServerClient {
  constructor({ url, cwd }) {
    this.url = url;
    this.cwd = cwd;
    this.socket = null;
    this.pendingRequests = new Map();
    this.nextRequestId = 1;
    this.appServerProcess = null;
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      await this.openSocket(CONNECT_TIMEOUT_MS);
    } catch {
      this.spawnAppServer();
      await this.waitForAppServer();
    }

    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'gitlab-mr-watch',
        title: 'GitLab MR Watch',
        version: '0.3.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  async createReviewThread({
    title,
    cwd,
    prompt,
    developerInstructions,
    model,
    effort,
  }) {
    if (!cwd) throw new Error('创建审查线程必须显式指定项目 cwd');
    await this.connect();

    const threadStartParams = {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: false,
      developerInstructions,
    };
    if (model) {
      threadStartParams.model = model;
    }

    const threadStartResult = await this.sendRequest('thread/start', threadStartParams);
    const threadId = threadStartResult.thread?.id ?? threadStartResult.threadId;
    if (!threadId) {
      throw new Error(`thread/start 没有返回 threadId: ${JSON.stringify(threadStartResult)}`);
    }

    try {
      await this.sendRequest('thread/name/set', {
        threadId,
        name: title,
      });
    } catch (error) {
      console.warn(`设置审查线程标题失败，继续创建: ${error.message}`);
    }

    const turnStartParams = {
      threadId,
      input: [{
        type: 'text',
        text: prompt,
      }],
      approvalPolicy: 'never',
    };
    if (model) {
      turnStartParams.model = model;
    }
    if (effort) {
      turnStartParams.effort = effort;
    }

    try {
      await this.sendRequest('turn/start', turnStartParams);
    } catch (error) {
      try {
        await this.sendRequest('thread/archive', { threadId });
      } catch {
        // Keep the original turn error; archiving is best-effort cleanup.
      }
      throw error;
    }

    return {
      threadId,
      title,
    };
  }

  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  async openSocket(timeoutMs) {
    await new Promise((resolveOpen, rejectOpen) => {
      const socket = new WebSocket(this.url);
      const timeout = setTimeout(() => {
        socket.close();
        rejectOpen(new Error(`连接 app-server 超时: ${this.url}`));
      }, timeoutMs);

      const handleOpen = () => {
        clearTimeout(timeout);
        socket.removeEventListener('error', handleError);
        this.attachSocket(socket);
        this.socket = socket;
        resolveOpen();
      };
      const handleError = (event) => {
        clearTimeout(timeout);
        socket.removeEventListener('open', handleOpen);
        rejectOpen(new Error(`连接 app-server 失败: ${event.message ?? 'WebSocket error'}`));
      };

      socket.addEventListener('open', handleOpen, { once: true });
      socket.addEventListener('error', handleError, { once: true });
    });
  }

  attachSocket(socket) {
    socket.addEventListener('message', (event) => {
      this.handleMessage(event);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pendingRequests.values()) {
        pending.rejectRequest(new Error('app-server 连接已关闭'));
      }
      this.pendingRequests.clear();
      if (this.socket === socket) {
        this.socket = null;
      }
    });
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (!message.id || !this.pendingRequests.has(message.id)) {
      return;
    }

    const pending = this.pendingRequests.get(message.id);
    this.pendingRequests.delete(message.id);
    if (message.error) {
      pending.rejectRequest(new Error(JSON.stringify(message.error)));
      return;
    }
    pending.resolveRequest(message.result ?? message);
  }

  sendRequest(method, params) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('app-server 尚未连接');
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));

    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectRequest(new Error(`app-server 请求超时: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolveRequest: (result) => {
          clearTimeout(timeout);
          resolveRequest(result);
        },
        rejectRequest: (error) => {
          clearTimeout(timeout);
          rejectRequest(error);
        },
      });
    });
  }

  spawnAppServer() {
    if (this.appServerProcess) {
      return;
    }

    this.startupError = null;
    this.appServerProcess = spawn('codex', ['app-server', '--listen', this.url], {
      cwd: this.cwd,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    this.appServerProcess.on('error', (error) => {
      this.startupError = error;
      this.appServerProcess = null;
    });
    this.appServerProcess.unref();
  }

  async waitForAppServer() {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastError = null;

    while (Date.now() < deadline) {
      if (this.startupError) throw new Error(`app-server 启动失败: ${this.startupError.message}`);
      try {
        await this.openSocket(1_000);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      }
    }

    throw new Error(`app-server 启动后仍不可连接: ${lastError?.message ?? this.url}`);
  }
}

export function createAppServerClient({ url, cwd }) {
  return new AppServerClient({ url, cwd });
}
