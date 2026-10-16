import { createHash } from "node:crypto";

/** The text in web/index.html that `GET /` replaces with the page's version, so a page knows which version it was served as. */
export const VERSION_MARK = "__PAGE_VERSION__";

/** The version of the page the daemon serves: a hash of its two files, web/index.html and the bundle web/dist/app.js. It changes
 * exactly when a page loaded now would differ from one loaded before, whatever else a deploy changed (docs/design.md, section 4,
 * Deploying). The files go in whole and as served, before the mark is replaced, so every reader of them gets the same version. */
export function pageVersion(html: Uint8Array, bundle: Uint8Array): string {
  const hash = createHash("sha256");
  // The length of the first file keeps a byte moved from one file to the other from making the same hash.
  hash.update(String(html.length)).update("\n").update(html).update(bundle);
  return hash.digest("hex").slice(0, 16);
}

/** `html` as `GET /` serves it: the mark replaced by `version`, or by nothing while the version is unknown (a page that does not know
 * its version never reloads itself). */
export function stampPage(html: string, version: string | undefined): string {
  return html.replace(VERSION_MARK, version ?? "");
}
