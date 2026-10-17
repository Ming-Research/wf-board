// What a tool says when a call's arguments are wrong, and which wrong names it reads as the right ones
// (docs/design.md, section 6, Lean replies). Everything is derived from the tool's own schema, so a new parameter is in
// the table and the example without anyone writing it twice.
import { z } from "zod";
import { REMOVED_PRIORITY } from "./model.ts";

/** The JSON Schema a tool advertises, reduced to the keywords this file reads. */
export interface Json {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: Json[];
  items?: Json;
  properties?: Record<string, Json>;
  required?: string[];
  description?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
}

/** The schema the SDK advertises for a tool: the same call, so the table says what the client was shown. */
export function jsonSchemaOf(schema: z.ZodType): Json {
  return z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as unknown as Json;
}

/** The phrase every refusal carries, which the tests look for. */
export const NOT_ACCEPTED = "arguments not accepted";

// --- The parameter table --------------------------------------------------------------------------------------------

function typeText(s: Json, depth = 0): string {
  if (s.anyOf) return s.anyOf.map(branch => typeText(branch, depth)).join(" | ");
  if (s.enum) return s.enum.map(v => typeof v === "string" ? v : JSON.stringify(v)).join("|");
  if (s.const !== undefined) return JSON.stringify(s.const);
  const type = Array.isArray(s.type) ? s.type.join("|") : s.type;
  if (type === "array") return `[${s.items ? typeText(s.items, depth) : "any"}]`;
  if (type === "object" && s.properties) {
    if (depth >= 2) return "object";
    const required = new Set(s.required ?? []);
    return `{${Object.entries(s.properties).map(([key, value]) => {
      const inner = typeText(value, depth + 1);
      return `${key}${required.has(key) ? "" : "?"}${inner === "string" ? "" : `: ${inner}`}`;
    }).join(", ")}}`;
  }
  return type ?? "any";
}

/** A description cut after its first sentence, so the table stays a table. */
function firstSentence(text: string | undefined): string {
  if (!text) return "";
  const first = text.split(/(?<=[.。])\s/)[0]!;
  return [...first].length > 110 ? `${[...first].slice(0, 110).join("")}…` : first;
}

/** One line per parameter: name, type, whether it is required, and the first sentence of what it is. */
export function parameterTable(json: Json): string[] {
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, value]) => `  ${name} (${typeText(value)}, ${required.has(name) ? "required" : "optional"})${value.description ? `: ${firstSentence(value.description)}` : ""}`);
}

// --- The example call -----------------------------------------------------------------------------------------------

/** Strings an example may use, in the order tried: the first that fits the parameter's pattern and length is the sample. */
const SAMPLE_STRINGS = ["example", "2026-10-11T06:15:40Z", "标签", "#1"];

function sampleString(s: Json): string {
  const fits = (text: string) => {
    const length = [...text].length;
    if (s.minLength !== undefined && length < s.minLength) return false;
    if (s.maxLength !== undefined && length > s.maxLength) return false;
    if (s.pattern === undefined) return true;
    try { return new RegExp(s.pattern, "u").test(text); } catch { return new RegExp(s.pattern).test(text); }
  };
  return SAMPLE_STRINGS.find(fits) ?? "example";
}

/** A value of the parameter's shape, built from its required parts only. */
export function sample(s: Json): unknown {
  if (s.anyOf) return sample(s.anyOf.find(branch => branch.type !== "null") ?? s.anyOf[0]!);
  if (s.const !== undefined) return s.const;
  if (s.enum) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type.find(t => t !== "null") : s.type;
  switch (type) {
    case "string": return sampleString(s);
    case "integer": case "number": return s.minimum ?? (s.exclusiveMinimum === undefined ? 1 : s.exclusiveMinimum + 1);
    case "boolean": return true;
    case "array": return s.items ? [sample(s.items)] : [];
    case "object": return Object.fromEntries((s.required ?? []).map(key => [key, sample(s.properties?.[key] ?? {})]));
    default: return "example";
  }
}

/** Calls written by hand for the tools that are refused most; every other tool gets the sample its schema builds. */
const EXAMPLES: Record<string, unknown> = {
  create_item: { key: "my-item", title: "让 X 能做 Y", head: "**问题**：……", accept: "测试 T 通过", owner: "parent-item", difficulty: 2, tags: ["看板"] },
  set_plan: { id: "my-item", row: { id: "step-1", text: "做 X", state: "doing", waits: "CI" } },
  update_item: { id: "my-item", rev: 3, head: "**问题**：……", reason: "为什么改正文" },
};

export function exampleCall(tool: string, json: Json): string {
  return `${tool} ${JSON.stringify(EXAMPLES[tool] ?? sample(json))}`;
}

// --- Reading wrong names --------------------------------------------------------------------------------------------

/** For a name the tool does not have, the names it may mean, in order. Only a name the tool lacks is read this way. */
const READ_AS: Record<string, string[]> = { key: ["id"], id: ["key"], item: ["id"], note: ["id"], project: ["group"] };
/** Names read as another only by one tool. */
const READ_AS_BY: Record<string, { tool: string; as: string }> = { plan: { tool: "set_plan", as: "rows" }, steps: { tool: "set_plan", as: "rows" } };

export interface Read { args: Record<string, unknown>; notes: string[] }

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The call's arguments with the wrong names read as the right ones. A name the tool has stays. A name it lacks is read as
 * the first name in READ_AS that the tool has and the call does not already give; or, when the tool has a `filters`
 * object that takes the name, as that filter. What it cannot place stays as it was, and validation names it.
 */
export function readNames(tool: string, json: Json, given: Record<string, unknown>): Read {
  const top = new Set(Object.keys(json.properties ?? {})), inner = new Set(Object.keys(json.properties?.["filters"]?.properties ?? {}));
  const by = (name: string): string[] => {
    const only = READ_AS_BY[name];
    return [name, ...(READ_AS[name] ?? []), ...(only && only.tool === tool ? [only.as] : [])];
  };
  const args: Record<string, unknown> = {}, notes: string[] = [];
  // Filters can take a name only when the caller's own filters, if any, are an object.
  const own = given["filters"];
  const mayFilter = own === undefined || isRecord(own);
  const filters: Record<string, unknown> = isRecord(own) ? { ...own } : {};
  let filtered = isRecord(own);
  for (const [name, value] of Object.entries(given)) if (top.has(name)) args[name] = value;
  for (const [name, value] of Object.entries(given)) {
    if (top.has(name)) continue;
    // Writes need an author and reads take none; a read given one is not worth a refusal.
    if (name === "author") { notes.push("author ignored: this tool takes none"); continue; }
    const place = by(name).find(candidate => (top.has(candidate) && !(candidate in args)) || (mayFilter && inner.has(candidate) && !(candidate in filters)));
    if (place === undefined) args[name] = value;
    else if (top.has(place)) { args[place] = value; notes.push(`${name} read as ${place}`); }
    else { filters[place] = value; filtered = true; notes.push(`${name} read as filters.${place}`); }
  }
  if (filtered) {
    // A name inside the filters that the filters lack is read the same way.
    for (const [name, value] of Object.entries(filters)) {
      if (inner.has(name)) continue;
      const place = by(name).find(candidate => inner.has(candidate) && !(candidate in filters));
      if (place === undefined) continue;
      delete filters[name];
      filters[place] = value;
      notes.push(`filters.${name} read as filters.${place}`);
    }
    args["filters"] = filters;
  }
  return { args, notes };
}

// --- Saying what is wrong -------------------------------------------------------------------------------------------

const pathText = (path: readonly PropertyKey[]): string => path.map((part, i) => typeof part === "number" ? `[${part}]` : `${i ? "." : ""}${String(part)}`).join("");
const valueAt = (value: unknown, path: readonly PropertyKey[]): unknown => path.reduce<unknown>((v, part) => isRecord(v) || Array.isArray(v) ? (v as Record<PropertyKey, unknown>)[part] : undefined, value);
const kindOf = (value: unknown): string => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const quoted = (path: readonly PropertyKey[]): string => `"${pathText(path)}"`;
const forms = (values: readonly unknown[]): string => values.map(v => typeof v === "string" ? v : JSON.stringify(v)).join(", ");

type Issue = z.core.$ZodIssue;

/** The issues in plain words, one line each. `given` is the value the paths are read from; a union's own issues are relative to the union. */
export function issueLines(issues: readonly Issue[], given: unknown, prefix: readonly PropertyKey[] = []): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path], where = path.length ? ` in ${pathText(path)}` : "";
    switch (issue.code) {
      case "unrecognized_keys": {
        // The removed priority is told as removed, not as unknown (docs/design.md, section 5, Priority).
        const rest = issue.keys.filter(k => k !== "priority");
        if (rest.length < issue.keys.length) out.push(`${REMOVED_PRIORITY}${where}`);
        if (rest.length) out.push(`unknown parameter ${rest.map(k => `"${k}"`).join(", ")}${where}`);
        break;
      }
      case "invalid_type":
        out.push(valueAt(given, path) === undefined ? `missing required parameter ${quoted(path)}` : `${quoted(path)} must be ${issue.expected}, got ${kindOf(valueAt(given, path))}`);
        break;
      case "invalid_value": out.push(`${quoted(path)} must be one of: ${forms(issue.values)}`); break;
      case "invalid_union": {
        // Every form fails at the value itself (a number or the word all): say so. Otherwise the form that fails least is the one meant.
        const branches: Issue[][] = issue.errors;
        const single = branches.length > 1 && branches.every(errors => errors.length === 1 && errors[0]!.path.length === 0 && (errors[0]!.code === "invalid_type" || errors[0]!.code === "invalid_value"));
        if (single) {
          const wanted = branches.map(errors => { const e = errors[0]!; return e.code === "invalid_type" ? e.expected : e.code === "invalid_value" ? e.values.map(v => JSON.stringify(v)).join("/") : ""; });
          out.push(`${quoted(path)} must be ${wanted.join(" or ")}, got ${kindOf(valueAt(given, path))}`);
        } else if (branches.length) {
          const closest = branches.reduce((best, errors) => errors.length < best.length ? errors : best, branches[0]!);
          out.push(...issueLines(closest, given, path));
        } else out.push(`${quoted(path)}: ${issue.message}`);
        break;
      }
      default: out.push(path.length ? `${quoted(path)}: ${issue.message}` : issue.message);
    }
  }
  return out;
}

/** The refusal a wrong call gets: what is wrong, the tool's parameters and a call that works. */
export function refusal(tool: string, json: Json, given: unknown, issues: readonly Issue[]): string {
  return [`${tool}: ${NOT_ACCEPTED}.`, ...issueLines(issues, given).map(line => `- ${line}`), "Parameters:", ...parameterTable(json), `Example: ${exampleCall(tool, json)}`].join("\n");
}
