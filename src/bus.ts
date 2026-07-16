// The smalltalk bus (members / status). Reads via @myobie/coord's read-only `createBusReader` — the
// in-process bus reader smalltalk exports — instead of spawning `st agents` and parsing its JSON.
// Same data, no subprocess, type-safe. The reader is pinned to an explicit state root (see
// `effectiveRoot`); writes (`setStatus`) still go through the `st` CLI, which is env-pinned.

import { createBusReader } from "@myobie/coord";
import { run } from "./exec.ts";
import { defaultConvoyNetwork } from "./paths.ts";

export type AgentState = "offline" | "available" | "busy" | "away" | "dnd" | "unknown";

export interface Agent {
  identity: string;
  status: AgentState;
  name: string | null;
  lastActivity: number | null; // ms epoch, fractional; present only with enrich
  inbox: number | null; // present only with enrich
}

const LIVE: ReadonlySet<AgentState> = new Set<AgentState>(["available", "busy", "away", "dnd"]);

export function isLive(s: AgentState): boolean {
  return LIVE.has(s);
}

export class Bus {
  readonly root: string | null;

  constructor(root: string | null) {
    this.root = root;
  }

  /** The state root the reader reads. `createBusReader` requires an explicit root (no env fallback of
   *  its own), so resolve one the same way `resolveNetworkRoot` does: an explicit root wins, else the
   *  ambient ST_ROOT, else convoy's own default network (never st's global smalltalk root). */
  private effectiveRoot(): string {
    return this.root ?? process.env["ST_ROOT"] ?? defaultConvoyNetwork();
  }

  /** Bus members. `enrich` adds `lastActivity` + `inbox`. Fail-soft: a missing/unreadable root reads
   *  as no agents (`[]`), exactly as the old `st agents` shell-out returned `[]` on failure. Kept async
   *  (the reader is synchronous) so callers are untouched. `status` arrives already normalized to the
   *  validated State enum, so there is nothing to decode/normalize convoy-side. */
  async agents(enrich = false): Promise<Agent[]> {
    try {
      const reader = createBusReader({ root: this.effectiveRoot() });
      const rows = enrich ? reader.agents({ enrich: true }) : reader.agents();
      return rows.map((a) => ({
        identity: a.identity,
        status: a.status,
        name: a.name ?? null,
        lastActivity: "lastActivity" in a && typeof a.lastActivity === "number" ? a.lastActivity : null,
        inbox: "inbox" in a && typeof a.inbox === "number" ? a.inbox : null,
      }));
    } catch {
      return [];
    }
  }

  private env(): NodeJS.ProcessEnv | undefined {
    if (!this.root) return undefined;
    return { ...process.env, ST_ROOT: this.root, PTY_ROOT: `${this.root}/pty` };
  }

  async setStatus(identity: string, state: string): Promise<void> {
    await run("st", ["status", identity, "--set", state], { env: this.env() });
  }

  /** Connectivity probe: the reader constructs + lists without throwing. */
  async roundTrips(): Promise<boolean> {
    try {
      createBusReader({ root: this.effectiveRoot() }).agents();
      return true;
    } catch {
      return false;
    }
  }
}
