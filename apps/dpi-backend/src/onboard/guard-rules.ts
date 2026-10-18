// Pure shell guard rules shared as a portable boundary: this module has no pi-durable imports.
// Keep TEST_RUNNER_GUARD_FIXTURES / DESTRUCTIVE_GUARD_FIXTURES in parity with plain pi's guards.

export type RewrittenCommand = { command: string; kinds: string[] };
export type DestructiveCommandRule = { label: string; reason: string };

type Segment = { text: string; sep: string };
type DestructivePattern = DestructiveCommandRule & { pattern: RegExp };

const VITEST_POOL_FLAGS = "--pool=forks --maxWorkers=2";
const JEST_SAFE_FLAGS = "--runInBand --forceExit";

/** Exact shared examples for the plain-pi test-runner behavior. */
export const TEST_RUNNER_GUARD_FIXTURES: readonly {
  name: string;
  command: string;
  rewritten?: RewrittenCommand;
  ambiguous?: boolean;
}[] = [
  { name: "bare vitest", command: "vitest", rewritten: { command: "npx vitest run --pool=forks --maxWorkers=2", kinds: ["vitest"] } },
  { name: "npx vitest", command: "npx vitest", rewritten: { command: "npx vitest run --pool=forks --maxWorkers=2", kinds: ["vitest"] } },
  { name: "pnpm exec vitest watch", command: "pnpm exec vitest watch", rewritten: { command: "pnpm exec vitest run --pool=forks --maxWorkers=2", kinds: ["vitest"] } },
  { name: "environment prefix", command: "CI=1 npx vitest run src/a.test.ts", rewritten: { command: "CI=1 npx vitest run --pool=forks --maxWorkers=2 src/a.test.ts", kinds: ["vitest"] } },
  { name: "vitest already safe", command: "pnpm vitest run --pool=forks --maxWorkers=2 src/a.test.ts" },
  { name: "jest", command: "npx jest src/a.test.ts", rewritten: { command: "npx jest src/a.test.ts --runInBand --forceExit", kinds: ["jest"] } },
  { name: "jest already safe", command: "pnpm exec jest --runInBand --forceExit" },
  { name: "playwright", command: "npx playwright test e2e", rewritten: { command: "npx playwright test --workers=1 e2e", kinds: ["playwright"] } },
  { name: "playwright already bounded", command: "pnpm exec playwright test --workers=2" },
  { name: "pytest unchanged", command: "python -m pytest -x -q" },
  { name: "npm test blocked", command: "npm test", ambiguous: true },
  { name: "npm t blocked", command: "CI=1 npm t", ambiguous: true },
  { name: "yarn test blocked", command: "yarn test", ambiguous: true },
  { name: "npm run test is not the bare alias", command: "npm run test" },
  { name: "rewrite each segment", command: "cd app && npx vitest; echo done", rewritten: { command: "cd app && npx vitest run --pool=forks --maxWorkers=2; echo done", kinds: ["vitest"] } },
  { name: "runner in a non-runner argument", command: "grep vitest README.md" },
  { name: "runner text in echo", command: "echo vitest" },
  { name: "heredoc is untouched", command: "npx vitest <<'EOF'\ntext\nEOF" },
];

/** Shared destructive-pattern fixtures checked against durable and plain-pi implementations. */
export const DESTRUCTIVE_GUARD_FIXTURES: readonly {
  name: string;
  command: string;
  label?: string;
}[] = [
  { name: "rm recursive force", command: "rm -rf scratch", label: "rm -rf" },
  { name: "rm force recursive", command: "rm -fr scratch", label: "rm -rf" },
  { name: "rm force", command: "rm -f scratch", label: "rm -f" },
  { name: "hard reset", command: "git reset --hard", label: "git reset --hard" },
  { name: "git clean", command: "git clean -fdx", label: "git clean" },
  { name: "force push", command: "git push origin branch --force-with-lease", label: "git push --force" },
  { name: "sudo", command: "sudo apt install package", label: "sudo" },
  { name: "drop table", command: "psql -c 'DROP TABLE users'", label: "SQL DROP/TRUNCATE" },
  { name: "truncate", command: "sqlite3 app.db 'TRUNCATE users'", label: "SQL DROP/TRUNCATE" },
  { name: "root chmod", command: "chmod -R 755 /", label: "chmod -R /" },
  { name: "recursive chown", command: "chown -R user directory", label: "chown -R" },
  { name: "kill nine", command: "kill -9 123", label: "kill -9 / killall" },
  { name: "killall", command: "killall process", label: "kill -9 / killall" },
  { name: "pkill", command: "pkill process", label: "kill -9 / killall" },
  { name: "dd output", command: "dd if=input of=/dev/sda", label: "dd of=" },
  { name: "filesystem format", command: "mkfs.ext4 /dev/sda", label: "mkfs" },
  { name: "fork bomb", command: ":() { :|:& };:", label: "fork bomb" },
  { name: "git delete branch is warn-only", command: "git branch -D topic" },
  { name: "echo text matches plain-pi baseline", command: "echo 'rm -rf scratch'", label: "rm -rf" },
  { name: "printf text matches plain-pi baseline", command: "printf '%s\\n' 'DROP TABLE users'", label: "SQL DROP/TRUNCATE" },
  { name: "quoted heredoc text matches plain-pi baseline", command: "cat <<'EOF'\nrm -rf scratch\nDROP TABLE users\nEOF", label: "rm -rf" },
  { name: "unquoted heredoc text matches plain-pi baseline", command: "cat <<EOF\nrm -rf scratch\nEOF", label: "rm -rf" },
  { name: "quoted executable heredoc", command: "bash <<'EOF'\nrm -rf scratch\nEOF", label: "rm -rf" },
  { name: "unquoted executable heredoc", command: "bash <<EOF\nrm -rf scratch\nEOF", label: "rm -rf" },
  { name: "single ampersand list", command: "echo safe & rm -rf scratch", label: "rm -rf" },
  { name: "process substitution", command: "echo <(rm -rf scratch)", label: "rm -rf" },
  { name: "echo command substitution remains guarded", command: "echo \"$(rm -rf scratch)\"", label: "rm -rf" },
  { name: "unquoted heredoc command substitution remains guarded", command: "cat <<EOF\n$(rm -rf scratch)\nEOF", label: "rm -rf" },
  { name: "dangerous later segment still guarded", command: "echo rm -rf scratch; rm -rf real", label: "rm -rf" },
];

/** Split on unquoted &&, ||, ;, |, newline. Keeps separators for exact segment-local reconstruction. */
export function splitSegments(command: string): Segment[] {
  const out: Segment[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[++i];
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      out.push({ text: current, sep: pair });
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      out.push({ text: current, sep: ch });
      current = "";
      continue;
    }
    current += ch;
  }
  out.push({ text: current, sep: "" });
  return out;
}

const RUNNER_RE = /^(\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)((?:pnpm\s+(?:dlx\s+|exec\s+)?|npx\s+(?:--yes\s+|-y\s+)?|yarn\s+(?:dlx\s+)?|bunx?\s+|npm\s+exec\s+)?)(\S+)(.*)$/s;

function parseInvocation(text: string): { env: string; runner: string; program: string; args: string } | null {
  const match = text.match(RUNNER_RE);
  if (!match) return null;
  return { env: match[1], runner: match[2], program: match[3], args: match[4] };
}

function hasFlag(args: string, flag: string): boolean {
  return new RegExp(`(^|[\\s=])${flag.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`).test(args);
}

function rewriteVitestSegment(text: string): string | null {
  const invocation = parseInvocation(text);
  if (!invocation || invocation.program !== "vitest") return null;
  if (hasFlag(invocation.args, "--pool=forks")) return null;
  const runner = invocation.runner.trim() || "npx";
  const args = invocation.args.trim();
  const rest = /^run(\s|$)/.test(args)
    ? args.replace(/^run\s*/, "")
    : args.replace(/^(watch|dev)(\s|$)\s*/, "");
  const trailing = text.match(/\s*$/)?.[0] ?? "";
  return `${invocation.env}${runner} vitest run ${VITEST_POOL_FLAGS}${rest ? ` ${rest}` : ""}${trailing}`;
}

function rewriteJestSegment(text: string): string | null {
  const invocation = parseInvocation(text);
  if (!invocation || invocation.program !== "jest") return null;
  if (hasFlag(invocation.args, "--runInBand")) return null;
  const runner = invocation.runner.trim() || "npx";
  const args = invocation.args.trim();
  const trailing = text.match(/\s*$/)?.[0] ?? "";
  return `${invocation.env}${runner} jest${args ? ` ${args}` : ""} ${JEST_SAFE_FLAGS}${trailing}`;
}

function rewritePlaywrightSegment(text: string): string | null {
  const invocation = parseInvocation(text);
  if (!invocation || invocation.program !== "playwright" || !/^\s*test(\s|$)/.test(invocation.args)) return null;
  if (hasFlag(invocation.args, "--workers")) return null;
  const runner = invocation.runner.trim() || "npx";
  const args = invocation.args.trim().replace(/^test\s*/, "");
  const trailing = text.match(/\s*$/)?.[0] ?? "";
  return `${invocation.env}${runner} playwright test --workers=1${args ? ` ${args}` : ""}${trailing}`;
}

/** Returns the rewritten command and touched runners, or null if it is already safe or not a runner invocation. */
export function rewriteCommand(command: string): RewrittenCommand | null {
  if (/<<-?\s*['"]?\w/.test(command)) return null;
  const kinds: string[] = [];
  let changed = false;
  const rewritten = splitSegments(command).map(({ text, sep }) => {
    const leading = text.match(/^\s*/)?.[0] ?? "";
    const body = text.slice(leading.length);
    for (const [kind, rewrite] of [
      ["vitest", rewriteVitestSegment],
      ["jest", rewriteJestSegment],
      ["playwright", rewritePlaywrightSegment],
    ] as const) {
      const next = rewrite(body);
      if (next !== null && next !== body) {
        kinds.push(kind);
        changed = true;
        return leading + next + sep;
      }
    }
    return text + sep;
  }).join("");
  return changed ? { command: rewritten, kinds } : null;
}

/** True when a segment directly invokes an ambiguous package-manager test alias. */
export function isAmbiguousTestScript(command: string): boolean {
  if (/<<-?\s*['"]?\w/.test(command)) return false;
  return splitSegments(command).some(({ text }) => {
    const match = text.match(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(npm|yarn)\s+(\S+)/);
    return !!match && ((match[1] === "npm" && (match[2] === "test" || match[2] === "t")) || (match[1] === "yarn" && match[2] === "test"));
  });
}

const DESTRUCTIVE_PATTERNS: readonly DestructivePattern[] = [
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*r/, label: "rm -rf", reason: "Recursive force-delete — can wipe directories irrecoverably." },
  { pattern: /\brm\s+-[a-zA-Z]*f\b/, label: "rm -f", reason: "Force-delete (no prompt). Confirm before allowing." },
  { pattern: /git\s+reset\s+--hard/, label: "git reset --hard", reason: "Discards uncommitted changes permanently." },
  { pattern: /git\s+clean\s+-[a-zA-Z]*[fdx]/, label: "git clean", reason: "Deletes untracked/ignored files permanently." },
  { pattern: /git\s+push\s+(?:.+\s)?(?:--force|-f\b|--force-with-lease)/, label: "git push --force", reason: "Overwrites remote history; can clobber teammates' work." },
  { pattern: /\bsudo\b/, label: "sudo", reason: "Runs with elevated privileges." },
  { pattern: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE)\b/i, label: "SQL DROP/TRUNCATE", reason: "Destructive database operation." },
  { pattern: /\bchmod\s+-R\s+[0-7]{3,4}\s+\//, label: "chmod -R /", reason: "Recursive chmod on root — system-wide permission change." },
  { pattern: /\bchown\s+-R\b/, label: "chown -R", reason: "Recursive ownership change." },
  { pattern: /\bkill\s+-9\b|\bkillall\b|\bpkill\b/, label: "kill -9 / killall", reason: "Force-kills processes." },
  { pattern: /\bdd\b.*\bof=/, label: "dd of=", reason: "Raw disk write — can overwrite disks/partitions." },
  { pattern: /\bmkfs\b/, label: "mkfs", reason: "Formats a filesystem — destroys all data on it." },
  { pattern: /:\(\)\s*\{.+:|:\|:\&\};:/, label: "fork bomb", reason: "Matches a shell fork-bomb pattern." },
];

function heredocDeclarations(line: string): { delimiter: string; stripTabs: boolean; quoted: boolean }[] {
  const result: { delimiter: string; stripTabs: boolean; quoted: boolean }[] = [];
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length - 1; index++) {
    const char = line[index];
    if (quote) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (line[index] !== "<" || line[index + 1] !== "<" || line[index + 2] === "<") continue;
    let cursor = index + 2;
    const stripTabs = line[cursor] === "-";
    if (stripTabs) cursor++;
    while (/\s/.test(line[cursor] ?? "")) cursor++;
    let delimiter = "";
    let quoted = false;
    if (line[cursor] === "'" || line[cursor] === '"') {
      const delimiterQuote = line[cursor++];
      quoted = true;
      while (cursor < line.length && line[cursor] !== delimiterQuote) delimiter += line[cursor++];
      if (line[cursor] === delimiterQuote) cursor++;
    } else {
      while (cursor < line.length && /[A-Za-z0-9_]/.test(line[cursor])) delimiter += line[cursor++];
    }
    if (delimiter) result.push({ delimiter, stripTabs, quoted });
    index = Math.max(index, cursor - 1);
  }
  return result;
}

/** First matching destructive rule. Inspect the full command, including here-doc bodies and output arguments. */
export function findDestructiveCommand(command: string): DestructiveCommandRule | undefined {
  for (const { text } of splitSegments(command)) {
    const rule = DESTRUCTIVE_PATTERNS.find((candidate) => candidate.pattern.test(text));
    if (rule) return { label: rule.label, reason: rule.reason };
  }
  return undefined;
}
