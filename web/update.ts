// What the page does when the server announces another version of it, as plain functions so tests can check it without a page.
// The server sends the current version as a "page" event on the page's stream (src/http.ts); the page knows the version it was
// served as from its own text. Equal versions change nothing; a different one makes the page reload itself, unless the owner is
// writing, when it waits until the writing is done (docs/design.md, section 7, Updating the page).

export interface UpdateEnv {
  /** The version this page was served as; empty when it does not know, and then it never reloads itself. */
  own: string;
  /** Whether the owner is writing something a reload would lose: an open comment box, an unsaved comment, a request in flight. */
  busy(): boolean;
  /** The line at the top of the page, or null to hide it. */
  banner(text: string | null): void;
  /** Reloads the page, after keeping what the new page must find again. */
  reload(): void;
  /** The last reload this page began because of a new version; kept across reloads, since the new page has to know it. */
  lastReload(): { version: string; at: number } | undefined;
  rememberReload(reload: { version: string; at: number }): void;
  now(): number;
  /** Calls `fn` once, `ms` from now. */
  later(fn: () => void, ms: number): void;
}

/** How often a page that waits for the owner to finish writing looks again. */
export const RECHECK_MS = 500;
/** A reload toward a version that left the page on another version less than this long ago is not repeated: something disagrees about
 * the version, and reloading again would loop. */
export const RELOAD_AGAIN_MS = 60_000;

export const WAITING = "看板已更新。写完保存这条评论后，页面会自动换成新版。";
export const STUCK = "看板已更新，但页面自动换新版没有成功。请手动刷新页面。";

export function pageUpdater(env: UpdateEnv): { announce(version: string): void } {
  // The version the server announced and this page is not yet on.
  let target: string | undefined;
  let looking = false, reloading = false;
  function settle() {
    if (target === undefined) return;
    const last = env.lastReload();
    if (last && last.version === target && env.now() - last.at < RELOAD_AGAIN_MS) { env.banner(STUCK); return; }
    if (env.busy()) {
      env.banner(WAITING);
      if (!looking) { looking = true; env.later(() => { looking = false; settle(); }, RECHECK_MS); }
      return;
    }
    env.rememberReload({ version: target, at: env.now() });
    // Until the page is gone, nothing it is told changes what it has begun.
    reloading = true; env.reload();
  }
  return {
    announce(version) {
      if (reloading) return;
      if (!env.own || version === env.own) { target = undefined; env.banner(null); return; }
      target = version;
      settle();
    },
  };
}
