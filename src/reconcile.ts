// convoy up's reconcile CORE — the declarative-arc payoff (piece 3). It computes DESIRED state (the synced
// catalog's agent files, host-filtered to THIS machine) against ACTUAL state (running pty sessions) and
// returns a PLAN: which agents to launch (render-if-not-rendered + spawn), which to tear down (retired),
// which to adopt (already alive), which to skip (another host's). `convoy up` and `convoy up --once` both
// drive this ONE function — up = reconcile on fs.watch(catalog/) + a timer; up --once = a single pass.
//
// This is what makes "declare on machine A, run on machine B" work: A writes catalog/<id>.toml with host=B,
// `fabric sync` propagates the catalog file to B (convoy declares its catalog to fabric sync — see
// src/fabric-sync.ts), and B's reconcile sees host==B + launches it. No RPC — the synced folder IS the
// scheduler. Pure (no side effects) so it's unit-testable; up executes the plan.

import type { AgentFile } from "./agent-file.ts";
import { gone, processAlive, type SupervisedSession } from "./host.ts";

// Discovery moved to catalog.ts when the catalog became a TREE of multi-format specs rather than a flat
// directory of `<identity>.toml`. Re-exported here so reconcile's consumers keep one import.
export { readCatalog, type Catalog, type CatalogEntry, type CatalogError, type CatalogWarning } from "./catalog.ts";
import type { CatalogEntry } from "./catalog.ts";

/** The host-prefixed bus id an agent file COMPILES to — `<host>.<identity>` (host defaults to `thisHost`).
 *  This is the key that matches a catalog agent to its running pty session (whose ST_AGENT is this id). */
export function agentBusId(af: AgentFile, thisHost: string): string {
  return `${af.host ?? thisHost}.${af.identity}`;
}

/** The reconcile PLAN — DESIRED (catalog) vs ACTUAL (sessions), host-filtered. Pure. */
export interface ReconcilePlan {
  /** Active, THIS host, NOT running → render-if-not-rendered + spawn (the flapping-cap applies at execution). */
  launch: CatalogEntry[];
  /** Retired, THIS host, WITH a live session → tear down (decommission = edit `retired=true`, honored here). */
  teardown: { entry: CatalogEntry; sessions: SupervisedSession[] }[];
  /** Active, THIS host, running + alive → adopt (leave it — the adopt-alive path, incl. a transiently-"gone"
   *  session whose pid is still alive). */
  adopt: { entry: CatalogEntry; sessions: SupervisedSession[] }[];
  /** host != THIS machine → skipped (another machine's `convoy up` launches it once the catalog syncs there). */
  otherHost: CatalogEntry[];
}

/** Compute the reconcile plan. `busIdOf` extracts a session's bus id (its ST_AGENT) — injected to keep this
 *  module free of a circular dep on up.ts. A session counts as LIVE for an agent when it's not `gone`, OR it's
 *  gone-but-pid-alive (pty can transiently report gone during a CPU spike — never re-launch a live process). */
export function reconcilePlan(
  entries: CatalogEntry[],
  sessions: SupervisedSession[],
  thisHost: string,
  busIdOf: (s: SupervisedSession) => string | null,
): ReconcilePlan {
  const byBusId = new Map<string, SupervisedSession[]>();
  for (const s of sessions) {
    const id = busIdOf(s);
    if (!id) continue;
    const arr = byBusId.get(id);
    if (arr) arr.push(s);
    else byBusId.set(id, [s]);
  }
  const liveOf = (id: string): SupervisedSession[] => (byBusId.get(id) ?? []).filter((s) => !gone(s) || processAlive(s.pid));

  const plan: ReconcilePlan = { launch: [], teardown: [], adopt: [], otherHost: [] };
  for (const entry of entries) {
    const host = entry.af.host ?? thisHost;
    if (host !== thisHost) {
      plan.otherHost.push(entry);
      continue;
    }
    const live = liveOf(agentBusId(entry.af, thisHost));
    if (entry.af.retired) {
      if (live.length > 0) plan.teardown.push({ entry, sessions: live });
      continue; // retired + not running → nothing to do
    }
    if (live.length > 0) plan.adopt.push({ entry, sessions: live });
    else plan.launch.push(entry);
  }
  return plan;
}
