import { ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';
import { WebSocket as UpstreamWebSocket } from 'ws';

export type CodexManagerOptions = {
  rpcPort: number;
  log: (message: string) => void;
  logError: (message: string) => void;
};

// Codex app-server lifecycle manager with ownership + reuse semantics.
export class CodexManager {
  private readonly rpcPort: number;

  private readonly log: (message: string) => void;

  private readonly logError: (message: string) => void;

  private readonly appServerListenUrl: string;

  private appServer: ChildProcess | null = null;

  private appServerOwned = false;

  private ensureAppServerPromise: Promise<void> | null = null;

  private lastAvailableAt = 0;

  constructor(options: CodexManagerOptions) {
    this.rpcPort = options.rpcPort;
    this.log = options.log;
    this.logError = options.logError;
    this.appServerListenUrl = `ws://127.0.0.1:${this.rpcPort}`;
  }

  get listenUrl(): string {
    return this.appServerListenUrl;
  }

  async ensureAvailable(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAvailableAt < 1500) {
      return;
    }

    if (await this.probePort()) {
      this.lastAvailableAt = Date.now();
      if (!this.appServerOwned) {
        this.log('reusing existing app-server process');
      }
      return;
    }

    if (this.ensureAppServerPromise) {
      return await this.ensureAppServerPromise;
    }

    this.ensureAppServerPromise = (async () => {
      if (await this.probePort()) {
        return;
      }

      this.spawnManagedAppServer();

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await this.probePort(300)) {
          this.lastAvailableAt = Date.now();
          return;
        }
        await this.sleep(120);
      }

      throw new Error('Timed out waiting for app-server to become available.');
    })();

    try {
      await this.ensureAppServerPromise;
    } finally {
      this.ensureAppServerPromise = null;
    }
  }

  createUpstreamWebSocket(): UpstreamWebSocket {
    return new UpstreamWebSocket(this.appServerListenUrl);
  }

  async stopGracefully(timeoutMs = 2500): Promise<void> {
    if (!this.appServerOwned || !this.appServer || this.appServer.exitCode !== null || this.appServer.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.appServer && this.appServer.exitCode === null && !this.appServer.killed) {
          this.appServer.kill('SIGKILL');
        }
        resolve();
      }, timeoutMs);

      this.appServer!.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.appServer!.kill('SIGTERM');
    });
  }

  forceStopOnExit(): void {
    if (this.appServerOwned && this.appServer && this.appServer.exitCode === null && !this.appServer.killed) {
      this.appServer.kill('SIGKILL');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async probePort(timeoutMs = 500): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      let finished = false;

      const finish = (result: boolean) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timeout);
        try {
          socket.destroy();
        } catch {
          // no-op
        }
        resolve(result);
      };

      const timeout = setTimeout(() => finish(false), timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
      socket.connect(this.rpcPort, '127.0.0.1');
    });
  }

  private spawnManagedAppServer() {
    if (this.appServer && this.appServer.exitCode === null && !this.appServer.killed) {
      return;
    }

    const child = spawn('codex', ['app-server', '--listen', this.appServerListenUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.appServer = child;
    this.appServerOwned = true;

    child.stdout.on('data', (chunk) => {
      this.log(String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      this.logError(String(chunk));
    });
    child.on('exit', (code, signal) => {
      if (this.appServer === child) {
        this.appServer = null;
      }
      this.logError(`exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });
  }
}
