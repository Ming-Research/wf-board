// The owner's browser notices, as plain functions so tests can check them without a page. The server sends each notice as an
// "owner" event on the page's stream (src/wake.ts `Told`); the page shows it only while the owner allowed notices.

/** A notice as the page receives it: a title, a message, and the card or item a click opens. */
export interface OwnerNotice { title: string; message: string; target?: { kind: "card" | "item"; key: string } }

/** What showing a notice needs from the page: the Notification constructor (absent in browsers without it), focus and opening. */
export interface NoticeEnv {
  Notification?: {
    permission: string;
    new (title: string, options: { body: string; tag: string }): { onclick: (() => void) | null; close(): void };
  };
  focus(): void;
  open(target: NonNullable<OwnerNotice["target"]>): void;
}

/** The notification's tag. The browser keeps one notification per tag, so the same card or item shows once across open tabs. */
export function noticeTag(notice: OwnerNotice): string {
  return notice.target ? notice.target.kind + ":" + notice.target.key : notice.title;
}

/** Shows the notice when the owner allowed notices. A click focuses the page and opens the target. Returns what was shown, if anything. */
export function showNotice(notice: OwnerNotice, env: NoticeEnv): { onclick: (() => void) | null; close(): void } | undefined {
  if (!env.Notification || env.Notification.permission !== "granted") return undefined;
  const shown = new env.Notification(notice.title, { body: notice.message, tag: noticeTag(notice) });
  shown.onclick = () => { shown.close(); env.focus(); if (notice.target) env.open(notice.target); };
  return shown;
}
