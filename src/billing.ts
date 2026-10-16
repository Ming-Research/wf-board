import { z } from "zod";
import { runGh } from "./github.ts";
import type { Gh } from "./github.ts";
import type { UsageReading, Visibility } from "./rules.ts";

/** What GitHub says about an organization's Actions billing, read into the shape the usage watch (src/usage-watch.ts) uses. */

export interface BillingSource {
  /** One look at an owner's Actions billing for the UTC month of `at`; `undefined` when the owner is a personal account, whose
   * billing the board cannot read (it needs a `user` token scope). Rejects with the reason when GitHub cannot be read. */
  read(owner: string, at: Date): Promise<UsageReading | undefined>;
}

const Usage = z.object({
  usageItems: z.array(z.object({
    date: z.string(), product: z.string(), sku: z.string(), quantity: z.number(), unitType: z.string(), repositoryName: z.string().optional(),
  }).catchall(z.unknown())),
});
const Budgets = z.object({
  budgets: z.array(z.object({
    budget_product_sku: z.string().optional(), budget_scope: z.string().optional(), budget_amount: z.number(), prevent_further_usage: z.boolean(),
  }).catchall(z.unknown())),
  has_next_page: z.boolean().optional(),
});

/** The minutes of the usage report: the Actions rows counted in minutes, each repository's per day and runner type. Other rows (storage) say nothing about minutes. */
export function parseUsage(text: string): UsageReading["rows"] {
  const parsed = Usage.safeParse(parseJson(text, "usage report"));
  if (!parsed.success) throw new Error(`usage report has an unexpected shape: ${issues(parsed.error)}`);
  return parsed.data.usageItems
    .filter(item => item.product.toLowerCase() === "actions" && item.unitType.toLowerCase() === "minutes" && item.repositoryName)
    .map(item => ({ date: item.date, repo: item.repositoryName!, sku: item.sku, minutes: item.quantity }));
}

/** The Actions budget of the organization itself, out of one page of the budgets: none when there is none. */
export function parseBudgets(text: string): { found?: { amount: number; stop: boolean }; more: boolean } {
  const parsed = Budgets.safeParse(parseJson(text, "budgets"));
  if (!parsed.success) throw new Error(`budgets have an unexpected shape: ${issues(parsed.error)}`);
  const budget = parsed.data.budgets.find(b => b.budget_product_sku?.toLowerCase() === "actions" && b.budget_scope?.toLowerCase() === "organization");
  return { ...(budget ? { found: { amount: budget.budget_amount, stop: budget.prevent_further_usage } } : {}), more: parsed.data.has_next_page === true };
}

/** The repositories of an organization with their visibility, from `name<TAB>visibility` lines, names in lower case. */
export function parseVisibility(text: string): Record<string, Visibility> {
  const out: Record<string, Visibility> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [name, visibility] = line.split("\t");
    if (!name || (visibility !== "public" && visibility !== "private" && visibility !== "internal")) throw new Error(`repository list has an unexpected line: ${JSON.stringify(line)}`);
    out[name.toLowerCase()] = visibility;
  }
  return out;
}

function parseJson(text: string, what: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error(`${what} is not JSON`); }
}
const issues = (error: z.ZodError) => error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");

/** The most budget pages read: an organization has one Actions budget among a handful. */
const BUDGET_PAGES = 5;

/** GitHub through the `gh` command line, which is signed in as the owner. */
export function ghBilling(gh: Gh = runGh): BillingSource {
  return {
    async read(owner, at) {
      const org = encodeURIComponent(owner), month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
      const fail = (what: string, error: unknown) => new Error(`${owner}: ${what}: ${message(error)}`);
      let listing: string;
      try { listing = await gh(["api", "--paginate", `/orgs/${org}/repos?per_page=100&type=all`, "--jq", ".[] | [.name, .visibility] | @tsv"]); }
      // A personal account has no organization repositories; that is no failure.
      catch (error) { if (/HTTP 404/.test(message(error))) return undefined; throw fail("repository list", error); }
      const call = async <T>(what: string, args: string[], parse: (text: string) => T): Promise<T> => {
        let text: string;
        try { text = await gh(["api", "-X", "GET", ...args]); } catch (error) { throw fail(what, error); }
        try { return parse(text); } catch (error) { throw fail(what, error); }
      };
      const [rows, budget] = await Promise.all([
        call("usage report", [`/organizations/${org}/settings/billing/usage`, "-f", `year=${at.getUTCFullYear()}`, "-f", `month=${at.getUTCMonth() + 1}`], parseUsage),
        (async () => {
          for (let page = 1; page <= BUDGET_PAGES; page++) {
            const { found, more } = await call("budgets", [`/organizations/${org}/settings/billing/budgets`, "-f", `page=${page}`], parseBudgets);
            if (found || !more) return found;
          }
          return undefined;
        })(),
      ]);
      let visibility: Record<string, Visibility>;
      try { visibility = parseVisibility(listing); } catch (error) { throw fail("repository list", error); }
      return { org: owner, month, at: at.toISOString(), rows, visibility, ...(budget ? { budget } : {}) };
    },
  };
}

function message(error: unknown): string {
  // execFile's message carries the command and then what gh printed on stderr; the reason is the last line.
  const lines = (error instanceof Error ? error.message : String(error)).split("\n").map(l => l.trim()).filter(Boolean);
  return lines.at(-1) ?? "gh failed";
}
