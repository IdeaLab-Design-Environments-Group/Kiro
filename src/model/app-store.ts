/**
 * Application **Model**: the single source of truth for UI state — the loaded
 * model and the current status line — with observer notification.
 *
 * Pure state: no DOM, no file parsing, no rendering. The Controller mutates it
 * (`update` / `setStatus`); Views subscribe and re-render. The *simulation*
 * model lives separately under `sim/` (the domain); this store only holds the
 * app/UI state that the three panels and the action buttons read.
 */
import type { LoadedModel } from "../types.js";

export type StatusKind = "" | "ok" | "bad";

export interface Status {
  msg: string;
  kind: StatusKind;
}

export interface AppState {
  model: LoadedModel | null;
  status: Status;
}

export type StateListener = (state: Readonly<AppState>) => void;

export class AppStore {
  private state: AppState = {
    model: null,
    status: { msg: "No model loaded.", kind: "" },
  };
  private readonly listeners = new Set<StateListener>();

  getState(): Readonly<AppState> {
    return this.state;
  }

  get model(): LoadedModel | null {
    return this.state.model;
  }

  /** Merge a partial state and notify all subscribers exactly once. */
  update(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Convenience: change only the status line (model untouched). */
  setStatus(msg: string, kind: StatusKind = ""): void {
    this.update({ status: { msg, kind } });
  }

  /** Subscribe and receive the current state immediately; returns an unsubscribe. */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
}
