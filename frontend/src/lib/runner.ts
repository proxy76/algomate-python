export type OutKind = "stdout" | "stderr";

export interface ExitInfo {
  code: number | null;
  duration_ms: number;
  reason: string | null;
}

export interface RunHandlers {
  onQueued(): void;
  onStarted(): void;
  onOutput(kind: OutKind, text: string): void;
  onExit(info: ExitInfo): void;
  onError(code: string, message: string): void;
}

/** One program execution over a dedicated WebSocket. */
export class RunSession {
  private ws: WebSocket;
  private finished = false;
  private queue: string[] = []; // input typed before the socket opened

  constructor(files: { name: string; content: string }[], entry: string, private h: RunHandlers) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/api/run`);
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ type: "run", files, entry }));
      for (const m of this.queue) this.ws.send(m);
      this.queue = [];
    };
    this.ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
    this.ws.onerror = () => this.fail("connection", "");
    this.ws.onclose = () => this.fail("connection", "");
  }

  private handle(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case "queued":
        return this.h.onQueued();
      case "started":
        return this.h.onStarted();
      case "stdout":
      case "stderr":
        return this.h.onOutput(msg.type, msg.data as string);
      case "exit":
        this.finished = true;
        return this.h.onExit(msg as unknown as ExitInfo);
      case "error":
        this.finished = true;
        return this.h.onError(msg.code as string, (msg.message as string) || "");
    }
  }

  private fail(code: string, message: string) {
    if (this.finished) return;
    this.finished = true;
    this.h.onError(code, message);
  }

  private send(obj: object) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(JSON.stringify(obj));
  }

  stdin(data: string) {
    this.send({ type: "stdin", data });
  }

  eof() {
    this.send({ type: "eof" });
  }

  kill() {
    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.finished = true;
      this.ws.close();
      this.h.onExit({ code: null, duration_ms: 0, reason: "killed" });
      return;
    }
    this.send({ type: "kill" });
  }

  get done() {
    return this.finished;
  }
}
