// The launchd job files (ops/*.plist) are templates: the installer (scripts/install-service.ts) fills in the values it chooses, and the
// deploy job (src/deploy.ts) fills the daemon's template in again when the checkout's template renders to something other than the file
// installed, with the values that file already holds (docs/design.md, section 4, Deploying).

const PLACEHOLDERS = ["NODE", "REPO", "HOME", "PATH", "DATA"] as const;
export type ServiceValues = Record<(typeof PLACEHOLDERS)[number], string>;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const NAMES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const escape = (text: string) => text.replace(/[&<>"']/g, c => ENTITIES[c]!);
const unescape = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => NAMES[name]!);

/** The template with each `{{NAME}}` replaced by its value, written for an XML text. A placeholder no value fills is an error: it would
 * otherwise land in the service file as it stands. */
export function renderPlist(template: string, values: ServiceValues): string {
  for (const [, name] of template.matchAll(/{{(\w+)}}/g)) {
    if (!(PLACEHOLDERS as readonly string[]).includes(name!)) throw new Error(`the service template has the placeholder {{${name}}}, which no value fills`);
  }
  return template.replace(new RegExp(`{{(${PLACEHOLDERS.join("|")})}}`, "g"), (_, key: keyof ServiceValues) => escape(values[key]));
}

/** What the installer chose for the daemon's service file, read back from the installed file by what launchd takes each as: the node is
 * the first of the program's arguments, the checkout its working directory, the PATH and the data directory two of its environment
 * variables. `HOME` is not read: it is the user the file is installed for, which only the caller knows. Throws when the file lacks one. */
export function installedValues(text: string): Omit<ServiceValues, "HOME"> {
  const read = (what: string, pattern: RegExp) => {
    const match = pattern.exec(text);
    if (!match) throw new Error(`the installed service file has no ${what}`);
    return unescape(match[1]!);
  };
  return {
    NODE: read("program (the first of its ProgramArguments)", /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/),
    REPO: read("WorkingDirectory", /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/),
    PATH: read("PATH in its EnvironmentVariables", /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/),
    DATA: read("WF_BOARD_DATA in its EnvironmentVariables", /<key>WF_BOARD_DATA<\/key>\s*<string>([^<]*)<\/string>/),
  };
}
