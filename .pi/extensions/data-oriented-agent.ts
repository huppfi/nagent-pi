import { compact, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const EXTENSION_ID = "data-oriented-agent";
const ARTIFACT_ROOT = join(".pi", "artifacts", "data-agent");
// Transcripts, branch tails, and machine state can contain secrets from tool output.
const ARTIFACT_GITIGNORE = ["sessions/", "checkpoints/", "state/", ""].join("\n");
const MAX_TRANSCRIPT_TEXT = 12_000;
const CHECKPOINT_TAIL_ENTRIES = 24;
const AUTO_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_CHECKPOINT_MAX_NEW_BYTES = 256 * 1024;

const artifactRoot = (cwd: string) => resolve(cwd, ARTIFACT_ROOT);
const sessionsRoot = (cwd: string) => join(artifactRoot(cwd), "sessions");
const checkpointsRoot = (cwd: string) => join(artifactRoot(cwd), "checkpoints");
const campaignsRoot = (cwd: string) => join(artifactRoot(cwd), "campaigns");
const knowledgeRoot = (cwd: string) => join(artifactRoot(cwd), "knowledge");
const sessionKnowledgeRoot = (cwd: string) => join(knowledgeRoot(cwd), "sessions");
const stateRoot = (cwd: string) => join(artifactRoot(cwd), "state");

function slugify(value: string, fallback = "untitled"): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || fallback;
}

function timestampSlug(date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

function truncateMiddle(text: string, max = MAX_TRANSCRIPT_TEXT): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.6);
	const tail = max - head;
	return `${text.slice(0, head)}\n\n...[truncated ${text.length - max} chars]...\n\n${text.slice(-tail)}`;
}

function fence(value: string, language = ""): string {
	const safe = value.replace(/```/g, "``\u200b`");
	return `\`\`\`${language}\n${safe}\n\`\`\``;
}

type ContentBlock = {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type SessionEntry = {
	type: string;
	id?: string;
	timestamp?: string | number;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
		command?: string;
		output?: string;
		exitCode?: number;
	};
	summary?: string;
	customType?: string;
	data?: unknown;
};

type AutoState = {
	lastCheckpointAt?: number;
	lastCheckpointBytes?: number;
	lastCheckpointEntryCount?: number;
};

function textParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const block = part as ContentBlock;
		return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
	});
}

function toolCalls(content: unknown): Array<{ name: string; args: Record<string, unknown> }> {
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") return [];
		return [{ name: block.name, args: block.arguments ?? {} }];
	});
}

function entryToMarkdown(entry: SessionEntry): string | undefined {
	const id = entry.id ? ` ${entry.id}` : "";
	const when = entry.timestamp ? ` — ${entry.timestamp}` : "";

	if (entry.type === "compaction" && entry.summary) {
		return `## Compaction${id}${when}\n\n${entry.summary.trim()}`;
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return `## Branch summary${id}${when}\n\n${entry.summary.trim()}`;
	}
	if (entry.type === "custom") {
		return undefined;
	}
	if (entry.type !== "message" || !entry.message?.role) {
		return undefined;
	}

	const role = entry.message.role;
	const title = role.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
	const chunks: string[] = [`## ${title}${id}${when}`];

	if (role === "assistant") {
		const calls = toolCalls(entry.message.content);
		const texts = textParts(entry.message.content).map((text) => text.trim()).filter(Boolean);
		if (texts.length) chunks.push(texts.join("\n\n"));
		if (calls.length) {
			chunks.push(
				"### Tool calls\n" +
					calls.map((call) => `- ${call.name}\n${fence(JSON.stringify(call.args, null, 2), "json")}`).join("\n"),
			);
		}
		return chunks.join("\n\n");
	}

	if (role === "toolResult") {
		const text = textParts(entry.message.content).join("\n").trim();
		chunks.push(`tool: ${entry.message.toolName ?? "unknown"}`);
		chunks.push(`error: ${entry.message.isError ? "yes" : "no"}`);
		if (text) chunks.push(fence(truncateMiddle(text), "text"));
		return chunks.join("\n\n");
	}

	if (role === "bashExecution") {
		if (entry.message.command) chunks.push(`command:\n${fence(entry.message.command, "bash")}`);
		chunks.push(`exit_code: ${entry.message.exitCode ?? "unknown"}`);
		if (entry.message.output) chunks.push(fence(truncateMiddle(entry.message.output), "text"));
		return chunks.join("\n\n");
	}

	const text = textParts(entry.message.content).join("\n").trim();
	if (text) chunks.push(text);
	return chunks.length > 1 ? chunks.join("\n\n") : undefined;
}

function getBranch(ctx: ExtensionContext | ExtensionCommandContext): SessionEntry[] {
	return ctx.sessionManager.getBranch() as SessionEntry[];
}

function getSessionId(ctx: ExtensionContext | ExtensionCommandContext): string {
	return slugify(ctx.sessionManager.getSessionId(), "session");
}

function getSessionFile(ctx: ExtensionContext | ExtensionCommandContext): string | undefined {
	return ctx.sessionManager.getSessionFile();
}

function branchBytes(entries: SessionEntry[]): number {
	return Buffer.byteLength(JSON.stringify(entries), "utf8");
}

function statePath(ctx: ExtensionContext | ExtensionCommandContext): string {
	return join(stateRoot(ctx.cwd), `${getSessionId(ctx)}.json`);
}

async function readAutoState(ctx: ExtensionContext | ExtensionCommandContext): Promise<AutoState> {
	try {
		const data = JSON.parse(await readFile(statePath(ctx), "utf8"));
		return data && typeof data === "object" ? data as AutoState : {};
	} catch {
		return {};
	}
}

async function writeAutoState(ctx: ExtensionContext | ExtensionCommandContext, state: AutoState): Promise<void> {
	await mkdir(stateRoot(ctx.cwd), { recursive: true });
	await writeFile(statePath(ctx), JSON.stringify(state, null, 2) + "\n", "utf8");
}

function firstUserPrompt(entries: SessionEntry[]): string {
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "user") {
			const text = textParts(entry.message.content).join("\n").trim();
			if (text) return truncateMiddle(text, 1_000);
		}
	}
	return "";
}

function latestUserPrompt(entries: SessionEntry[]): string {
	for (const entry of [...entries].reverse()) {
		if (entry.type === "message" && entry.message?.role === "user") {
			const text = textParts(entry.message.content).join("\n").trim();
			if (text) return truncateMiddle(text, 1_000);
		}
	}
	return "";
}

function collectFileOps(entries: SessionEntry[]): { readFiles: string[]; modifiedFiles: string[]; shellCommands: string[] } {
	const readFiles = new Set<string>();
	const modifiedFiles = new Set<string>();
	const shellCommands: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		for (const call of toolCalls(entry.message.content)) {
			const path = typeof call.args.path === "string" ? call.args.path : undefined;
			if (path && ["read", "grep", "find", "ls"].includes(call.name)) readFiles.add(path);
			if (path && ["write", "edit"].includes(call.name)) modifiedFiles.add(path);
			if (call.name === "bash" && typeof call.args.command === "string") shellCommands.push(call.args.command);
		}
	}
	return {
		readFiles: [...readFiles].sort(),
		modifiedFiles: [...modifiedFiles].sort(),
		shellCommands,
	};
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function branchTextEntries(entries: SessionEntry[]): Array<{ role: string; id: string; text: string }> {
	const result: Array<{ role: string; id: string; text: string }> = [];
	for (const entry of entries) {
		if (entry.type === "compaction" && entry.summary) {
			result.push({ role: "compaction", id: entry.id ?? "", text: entry.summary });
			continue;
		}
		if (entry.type === "branch_summary" && entry.summary) {
			result.push({ role: "branch-summary", id: entry.id ?? "", text: entry.summary });
			continue;
		}
		if (entry.type !== "message" || !entry.message?.role) continue;
		const text = textParts(entry.message.content).join("\n").trim();
		if (text) result.push({ role: entry.message.role, id: entry.id ?? "", text });
	}
	return result;
}

function lineMatches(entries: SessionEntry[], pattern: RegExp, maxPerEntry = 3): string[] {
	const lines: string[] = [];
	for (const item of branchTextEntries(entries)) {
		let count = 0;
		for (const rawLine of item.text.split(/\r?\n/)) {
			const line = rawLine.replace(/^[-*]\s*/, "").trim();
			if (line.length < 12 || !pattern.test(line)) continue;
			lines.push(`- (${item.role}${item.id ? ` ${item.id}` : ""}) ${line.slice(0, 240)}`);
			count += 1;
			if (count >= maxPerEntry) break;
		}
	}
	return uniqueSorted(lines);
}

function buildDistillFiles(ctx: ExtensionContext | ExtensionCommandContext): Record<string, string> {
	const entries = getBranch(ctx);
	const ops = collectFileOps(entries);
	const sessionId = getSessionId(ctx);
	const latestGoal = latestUserPrompt(entries) || firstUserPrompt(entries) || "(none)";
	const decisions = lineMatches(entries, /\b(decided|decision|choose|chose|because|rationale|tradeoff|instead)\b/i);
	const questions = lineMatches(entries, /\?|\b(blocked|unknown|open question|todo|follow up|follow-up)\b/i);
	const facts = uniqueSorted([
		`- session: ${sessionId}`,
		`- cwd: ${ctx.cwd}`,
		`- entries_on_branch: ${entries.length}`,
		`- latest_goal: ${latestGoal.replace(/\s+/g, " ").slice(0, 240)}`,
		...ops.readFiles.map((path) => `- read: ${path}`),
		...ops.modifiedFiles.map((path) => `- modified: ${path}`),
	]);
	const fileNotes = uniqueSorted([
		...ops.readFiles.map((path) => `- ${path}: read/inspected in session ${sessionId}`),
		...ops.modifiedFiles.map((path) => `- ${path}: modified in session ${sessionId}`),
	]);
	const commands = ops.shellCommands.map((command) => `- ${command.split("\n")[0].slice(0, 240)}`);
	const sessionHarvest = [
		`# Session harvest: ${sessionId}`,
		"",
		`- harvested: ${new Date().toISOString()}`,
		`- session_file: ${getSessionFile(ctx) ?? "ephemeral"}`,
		`- entries_on_branch: ${entries.length}`,
		"",
		"## Goal",
		"",
		latestGoal,
		"",
		"## Facts",
		facts.join("\n") || "(none)",
		"",
		"## Decisions / rationale candidates",
		decisions.join("\n") || "(none detected)",
		"",
		"## Open questions / follow-ups",
		questions.join("\n") || "(none detected)",
		"",
		"## File notes",
		fileNotes.join("\n") || "(none detected)",
		"",
		"## Shell commands",
		commands.join("\n") || "(none detected)",
		"",
	].join("\n");

	return {
		[join("sessions", `${sessionId}.md`)]: sessionHarvest,
		"facts.md": [`# Facts`, "", ...facts].join("\n"),
		"decisions.md": [`# Decision candidates`, "", decisions.join("\n") || "(none detected)", ""].join("\n"),
		"file-notes.md": [`# File notes`, "", fileNotes.join("\n") || "(none detected)", ""].join("\n"),
		"open-questions.md": [`# Open questions and follow-ups`, "", questions.join("\n") || "(none detected)", ""].join("\n"),
		"commands.md": [`# Shell commands`, "", commands.join("\n") || "(none detected)", ""].join("\n"),
	};
}

async function writeDistill(ctx: ExtensionContext | ExtensionCommandContext): Promise<string[]> {
	const root = knowledgeRoot(ctx.cwd);
	await mkdir(root, { recursive: true });
	await mkdir(sessionKnowledgeRoot(ctx.cwd), { recursive: true });
	const files = buildDistillFiles(ctx);
	const written: string[] = [];
	for (const [relativePath, content] of Object.entries(files)) {
		const path = join(root, relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
		written.push(path);
	}
	return written.sort();
}

function dataCompactInstructions(extra: string): string {
	const trimmed = extra.trim();
	if (trimmed.includes("Use a nagent-style data-oriented summary.")) return trimmed;
	return [
		"Use a nagent-style data-oriented summary. Preserve facts needed to resume work, not chat flavor.",
		"Use this structure: Goal; Constraints & Preferences; Progress Done/In Progress/Blocked; Key Decisions with rationale; File state; Commands and verification; Next Steps; Critical Context.",
		"Name exact file paths that were read or modified. Distinguish verified facts from assumptions.",
		trimmed ? `User extra instructions: ${trimmed}` : "",
	].filter(Boolean).join("\n");
}

async function runAutomaticMaintenance(ctx: ExtensionContext): Promise<string[]> {
	const entries = getBranch(ctx);
	const bytes = branchBytes(entries);
	const now = Date.now();
	const state = await readAutoState(ctx);
	const actions: string[] = [];
	const bytesSinceCheckpoint = bytes - (state.lastCheckpointBytes ?? 0);
	const checkpointAge = now - (state.lastCheckpointAt ?? 0);
	const checkpointDue = entries.length > 0 && (
		(!state.lastCheckpointAt && bytes > AUTO_CHECKPOINT_MAX_NEW_BYTES) ||
		bytesSinceCheckpoint > AUTO_CHECKPOINT_MAX_NEW_BYTES ||
		(Boolean(state.lastCheckpointAt) && checkpointAge >= AUTO_CHECKPOINT_INTERVAL_MS && bytesSinceCheckpoint > 0)
	);

	if (checkpointDue) {
		const checkpoint = await writeCheckpoint(ctx, "auto");
		state.lastCheckpointAt = now;
		state.lastCheckpointBytes = bytes;
		state.lastCheckpointEntryCount = entries.length;
		actions.push(`auto checkpoint: ${relative(ctx.cwd, checkpoint)}`);
	}

	await writeAutoState(ctx, state);
	return actions;
}

function buildTranscript(ctx: ExtensionContext | ExtensionCommandContext): string {
	const entries = getBranch(ctx);
	const sessionFile = getSessionFile(ctx);
	const ops = collectFileOps(entries);
	const body = entries.map(entryToMarkdown).filter((text): text is string => Boolean(text)).join("\n\n---\n\n");
	return [
		"# Pi session transcript",
		"",
		`- exported: ${new Date().toISOString()}`,
		`- cwd: ${ctx.cwd}`,
		`- session_file: ${sessionFile ?? "ephemeral"}`,
		`- entries_on_branch: ${entries.length}`,
		"",
		"## First user prompt",
		"",
		firstUserPrompt(entries) || "(none)",
		"",
		"## File operations",
		"",
		"### Read files",
		ops.readFiles.length ? ops.readFiles.map((p) => `- ${p}`).join("\n") : "(none detected)",
		"",
		"### Modified files",
		ops.modifiedFiles.length ? ops.modifiedFiles.map((p) => `- ${p}`).join("\n") : "(none detected)",
		"",
		"## Transcript",
		"",
		body || "(empty branch)",
	].join("\n");
}

async function writeTranscript(ctx: ExtensionContext | ExtensionCommandContext): Promise<string> {
	const sessionDir = join(sessionsRoot(ctx.cwd), getSessionId(ctx));
	await mkdir(sessionDir, { recursive: true });
	const transcriptPath = join(sessionDir, "transcript.md");
	await writeFile(transcriptPath, buildTranscript(ctx), "utf8");
	return transcriptPath;
}

async function ensureArtifactGitignore(root: string): Promise<void> {
	await writeFile(join(root, ".gitignore"), ARTIFACT_GITIGNORE, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
}

async function writeIndex(ctx: ExtensionContext | ExtensionCommandContext, extraLines: string[] = []): Promise<string> {
	const root = artifactRoot(ctx.cwd);
	await mkdir(root, { recursive: true });
	await ensureArtifactGitignore(root);
	const relRoot = relative(ctx.cwd, root) || root;
	const content = [
		"# Data-oriented Pi artifacts",
		"",
		"This directory is maintained by the `data-oriented-agent` Pi extension.",
		"It turns Pi's durable JSONL session into project-owned Markdown artifacts.",
		"",
		`- artifact_root: ${relRoot}`,
		`- last_update: ${new Date().toISOString()}`,
		`- current_session: ${getSessionId(ctx)}`,
		"",
		"## Layout",
		"",
		"- `sessions/<session-id>/transcript.md` — deterministic export of the current branch",
		"- `checkpoints/*.md` — user-created restart/checkpoint files",
		"- `campaigns/<slug>/campaign.md` — file-backed long-horizon plans",
		"- `knowledge/*.md` — distilled facts, decisions, file notes, commands, and open questions",
		"",
		"`.gitignore` excludes sessions, checkpoints, and state by default because they can contain secrets from tool output; edit it to commit them.",
		"",
		...extraLines,
		"",
	].join("\n");
	const indexPath = join(root, "README.md");
	await writeFile(indexPath, content, "utf8");
	return indexPath;
}

async function writeCheckpoint(ctx: ExtensionContext | ExtensionCommandContext, name: string): Promise<string> {
	const entries = getBranch(ctx);
	const ops = collectFileOps(entries);
	await mkdir(checkpointsRoot(ctx.cwd), { recursive: true });
	const stem = `${timestampSlug()}-${slugify(name || latestUserPrompt(entries).slice(0, 48), "checkpoint")}`;
	const checkpointPath = join(checkpointsRoot(ctx.cwd), `${stem}.md`);
	const tail = entries.slice(-CHECKPOINT_TAIL_ENTRIES).map(entryToMarkdown).filter((text): text is string => Boolean(text));
	const content = [
		`# Checkpoint: ${name || "unnamed"}`,
		"",
		`- created: ${new Date().toISOString()}`,
		`- cwd: ${ctx.cwd}`,
		`- session: ${getSessionId(ctx)}`,
		`- session_file: ${getSessionFile(ctx) ?? "ephemeral"}`,
		`- entries_on_branch: ${entries.length}`,
		"",
		"## Goal / latest user prompt",
		"",
		latestUserPrompt(entries) || "(none)",
		"",
		"## Touched data",
		"",
		"### Read files",
		ops.readFiles.length ? ops.readFiles.map((p) => `- ${p}`).join("\n") : "(none detected)",
		"",
		"### Modified files",
		ops.modifiedFiles.length ? ops.modifiedFiles.map((p) => `- ${p}`).join("\n") : "(none detected)",
		"",
		"### Shell commands",
		ops.shellCommands.length ? ops.shellCommands.map((cmd) => `- ${cmd.split("\n")[0].slice(0, 160)}`).join("\n") : "(none detected)",
		"",
		"## Resume instructions",
		"",
		"When resuming, inspect the files above and the current git diff before continuing. Treat this checkpoint as restart data, not as authority over the repository.",
		"",
		"## Recent branch tail",
		"",
		tail.join("\n\n---\n\n") || "(empty)",
	].join("\n");
	await writeFile(checkpointPath, content, "utf8");
	return checkpointPath;
}

async function report(ctx: ExtensionCommandContext, text: string): Promise<void> {
	if (ctx.hasUI) ctx.ui.notify(text, "info");
	else console.log(text);
}

async function sendVisible(pi: ExtensionAPI, ctx: ExtensionCommandContext, content: string): Promise<void> {
	// Keep command output visible in the session, but do not trigger an LLM turn.
	// The custom message participates in context, which is intentional for checkpoints:
	// the next turn can see the durable artifact location.
	pi.sendMessage({ customType: EXTENSION_ID, content, display: true });
	if (!ctx.hasUI) console.log(content);
}

async function listCampaigns(ctx: ExtensionCommandContext): Promise<string> {
	try {
		const entries = await readdir(campaignsRoot(ctx.cwd), { withFileTypes: true });
		const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
		return names.length ? names.map((name) => `- ${name}`).join("\n") : "(no campaigns)";
	} catch {
		return "(no campaigns)";
	}
}

async function handleCampaign(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const [verbRaw = "list", ...rest] = args.trim().split(/\s+/);
	const verb = verbRaw.toLowerCase();

	if (verb === "list" || !args.trim()) {
		const list = await listCampaigns(ctx);
		await sendVisible(pi, ctx, `Campaigns:\n${list}`);
		return;
	}

	if (verb === "new") {
		const [rawSlug, ...goalParts] = rest;
		if (!rawSlug) {
			await sendVisible(pi, ctx, "Usage: /data-campaign new <slug> <goal>");
			return;
		}
		const slug = slugify(rawSlug);
		const goal = goalParts.join(" ").trim() || "(write the goal here)";
		await mkdir(campaignsRoot(ctx.cwd), { recursive: true });
		const dir = join(campaignsRoot(ctx.cwd), slug);
		await mkdir(dir, { recursive: true });
		const path = join(dir, "campaign.md");
		const content = [
			`# Campaign: ${slug}`,
			"",
			`Created: ${new Date().toISOString()}`,
			"",
			"## Goal",
			"",
			goal,
			"",
			"## Constraints / data",
			"",
			"- Inspect real files before changing behavior.",
			"- Keep durable progress in this campaign file or linked item files.",
			"",
			"## Items",
			"",
			"- [ ] Inventory the real input/output data and current implementation.",
			"- [ ] Make the smallest verified change.",
			"- [ ] Record verification evidence.",
			"",
		].join("\n");
		await writeFile(path, content, "utf8");
		await sendVisible(pi, ctx, `Created campaign: ${relative(ctx.cwd, path)}`);
		return;
	}

	if (verb === "status") {
		const [rawSlug] = rest;
		if (!rawSlug) {
			await sendVisible(pi, ctx, "Usage: /data-campaign status <slug>");
			return;
		}
		const path = join(campaignsRoot(ctx.cwd), slugify(rawSlug), "campaign.md");
		try {
			const content = await readFile(path, "utf8");
			await sendVisible(pi, ctx, content);
		} catch {
			await sendVisible(pi, ctx, `Campaign not found: ${rawSlug}`);
		}
		return;
	}

	if (verb === "add") {
		const [rawSlug, ...itemParts] = rest;
		const item = itemParts.join(" ").trim();
		if (!rawSlug || !item) {
			await sendVisible(pi, ctx, "Usage: /data-campaign add <slug> <item>");
			return;
		}
		const path = join(campaignsRoot(ctx.cwd), slugify(rawSlug), "campaign.md");
		try {
			const current = await readFile(path, "utf8");
			await writeFile(path, `${current.replace(/\s*$/, "\n")}- [ ] ${item}\n`, "utf8");
			await sendVisible(pi, ctx, `Added item to ${relative(ctx.cwd, path)}: ${item}`);
		} catch {
			await sendVisible(pi, ctx, `Campaign not found: ${rawSlug}`);
		}
		return;
	}

	await sendVisible(pi, ctx, "Usage: /data-campaign [list|new|status|add] ...");
}

function isRecursiveForcedRm(command: string): boolean {
	for (const segment of command.split(/[;&|\n()]+/)) {
		const words = segment.trim().split(/\s+/);
		const rmIndex = words.findIndex((word) => word === "rm" || word.endsWith("/rm"));
		if (rmIndex === -1) continue;
		let recursive = false;
		let force = false;
		for (const word of words.slice(rmIndex + 1)) {
			if (word === "--") break;
			if (word === "--recursive") recursive = true;
			else if (word === "--force") force = true;
			else if (/^-[a-zA-Z]+$/.test(word)) {
				if (/[rR]/.test(word)) recursive = true;
				if (word.includes("f")) force = true;
			}
		}
		if (recursive && force) return true;
	}
	return false;
}

function suspiciousBash(command: string): string | undefined {
	if (isRecursiveForcedRm(command)) return "recursive forced delete";
	const patterns: Array<[RegExp, string]> = [
		[/\bgit\s+reset\s+--hard\b/, "git reset --hard"],
		[/\bgit\s+clean\s+-[^\n;]*f/, "git clean -f"],
		[/\bsudo\b/, "sudo command"],
		[/>\s*(\.env|[^\s;]*\/\.env)\b/, "shell redirection to .env"],
	];
	return patterns.find(([pattern]) => pattern.test(command))?.[1];
}

function sensitivePath(pathValue: string, cwd: string): string | undefined {
	const abs = resolve(cwd, pathValue.replace(/^@/, ""));
	const rel = relative(cwd, abs).replace(/\\/g, "/");
	const homeRel = relative(homedir(), abs).replace(/\\/g, "/");
	if (rel === ".git" || rel.startsWith(".git/")) return ".git";
	if (rel === "node_modules" || rel.startsWith("node_modules/")) return "node_modules";
	if (rel === ".env" || rel.endsWith("/.env")) return ".env";
	if (homeRel === ".ssh" || homeRel.startsWith(".ssh/")) return "~/.ssh";
	return undefined;
}

export default function (pi: ExtensionAPI) {
	const globalState = globalThis as typeof globalThis & { __dataOrientedAgentLoaded?: boolean };
	if (globalState.__dataOrientedAgentLoaded) return;
	globalState.__dataOrientedAgentLoaded = true;

	pi.on("session_shutdown", async () => {
		globalState.__dataOrientedAgentLoaded = false;
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(EXTENSION_ID, "data artifacts on");
		}
	});

	pi.on("before_agent_start", async (event) => {
		// A named section lets Pi keep its structured prompt and send only a delta,
		// instead of replacing the whole system prompt on every run.
		event.systemPromptOptions.sections.data_oriented_workflow = [
			"- Treat the Pi JSONL session as durable state, but put project-relevant memory in explicit files under `.pi/artifacts/data-agent/` or project docs.",
			"- For non-trivial work, maintain an artifact: a plan, checkpoint, campaign file, decision note, or verification log.",
			"- Automatic maintenance exports transcripts after runs and checkpoints large/old deltas; Pi compaction uses data-oriented summary instructions when this extension is loaded.",
			"- Do not rely on chat memory for facts that must survive restart; write or update the artifact that owns those facts.",
			"- Before changing behavior, inspect the real input data, current files, and tests. State what was verified.",
			"- Prefer smallest correct transforms over speculative abstractions.",
		].join("\n");
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return undefined;

		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				if (ctx.hasUI) ctx.ui.notify(`Data-oriented compaction auth failed: ${auth.error}; using Pi default`, "warning");
				return undefined;
			}
			// Route through the model registry so extension-registered providers work like Pi's own compaction.
			const result = await compact(
				event.preparation,
				model,
				auth.apiKey,
				auth.headers && Object.fromEntries(Object.entries(auth.headers).filter((header): header is [string, string] => header[1] !== null)),
				dataCompactInstructions(event.customInstructions ?? ""),
				event.signal,
				pi.getThinkingLevel(),
				(streamModel, context, options) => ctx.modelRegistry.streamSimple(streamModel, context, options),
				auth.env,
			);
			if (ctx.hasUI) ctx.ui.notify("Using data-oriented summary format for Pi compaction", "info");
			return { compaction: result };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI && !event.signal.aborted) ctx.ui.notify(`Data-oriented compaction failed: ${message}; using Pi default`, "warning");
			return undefined;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		try {
			const transcript = await writeTranscript(ctx);
			const maintenance = await runAutomaticMaintenance(ctx);
			await writeIndex(ctx, [
				`Latest transcript: \`${relative(ctx.cwd, transcript)}\``,
				maintenance.length ? "Automatic maintenance:" : "Automatic maintenance: none due",
				...maintenance.map((line) => `- ${line}`),
			]);
			if (maintenance.length && ctx.hasUI) ctx.ui.notify(maintenance.join("\n"), "info");
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Data artifact export failed: ${message}`, "warning");
			}
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if ((event.toolName === "write" || event.toolName === "edit") && typeof event.input.path === "string") {
			const protectedName = sensitivePath(event.input.path, ctx.cwd);
			if (protectedName) {
				return { block: true, reason: `data-oriented-agent blocked modification to protected path: ${protectedName}` };
			}
		}

		if (event.toolName === "bash" && typeof event.input.command === "string") {
			const reason = suspiciousBash(event.input.command);
			if (!reason) return undefined;
			if (!ctx.hasUI) {
				return { block: true, reason: `data-oriented-agent blocked ${reason} in non-interactive mode` };
			}
			const ok = await ctx.ui.confirm("Risky shell command", `Allow ${reason}?\n\n${event.input.command}`);
			if (!ok) return { block: true, reason: `User denied ${reason}` };
		}
		return undefined;
	});

	pi.registerCommand("data-artifacts", {
		description: "Export the current Pi branch to project-owned data-oriented artifacts",
		handler: async (_args, ctx) => {
			const transcript = await writeTranscript(ctx);
			const index = await writeIndex(ctx, [`Latest transcript: \`${relative(ctx.cwd, transcript)}\``]);
			await sendVisible(
				pi,
				ctx,
				[`Data artifacts updated:`, `- ${relative(ctx.cwd, index)}`, `- ${relative(ctx.cwd, transcript)}`].join("\n"),
			);
			await report(ctx, "Data artifacts exported");
		},
	});

	pi.registerCommand("data-checkpoint", {
		description: "Write a restart checkpoint under .pi/artifacts/data-agent/checkpoints/",
		handler: async (args, ctx) => {
			const transcript = await writeTranscript(ctx);
			const checkpoint = await writeCheckpoint(ctx, args.trim());
			await writeIndex(ctx, [
				`Latest transcript: \`${relative(ctx.cwd, transcript)}\``,
				`Latest checkpoint: \`${relative(ctx.cwd, checkpoint)}\``,
			]);
			await sendVisible(pi, ctx, `Checkpoint written: ${relative(ctx.cwd, checkpoint)}`);
			await report(ctx, "Data checkpoint written");
		},
	});

	pi.registerCommand("data-distill", {
		description: "Harvest current Pi branch into nagent-style knowledge files under .pi/artifacts/data-agent/knowledge/",
		handler: async (_args, ctx) => {
			const transcript = await writeTranscript(ctx);
			const written = await writeDistill(ctx);
			await writeIndex(ctx, [
				`Latest transcript: \`${relative(ctx.cwd, transcript)}\``,
				`Knowledge files:`,
				...written.map((path) => `- \`${relative(ctx.cwd, path)}\``),
			]);
			await sendVisible(pi, ctx, [`Knowledge distilled:`, ...written.map((path) => `- ${relative(ctx.cwd, path)}`)].join("\n"));
			await report(ctx, "Data knowledge distilled");
		},
	});

	pi.registerCommand("data-status", {
		description: "Show data-agent artifact status for the current session branch",
		handler: async (_args, ctx) => {
			const entries = getBranch(ctx);
			const bytes = branchBytes(entries);
			const ops = collectFileOps(entries);
			const campaigns = await listCampaigns(ctx);
			const state = await readAutoState(ctx);
			const status = [
				"Data-agent status:",
				`- artifact_root: ${ARTIFACT_ROOT}`,
				`- session: ${getSessionId(ctx)}`,
				`- session_file: ${getSessionFile(ctx) ?? "ephemeral"}`,
				`- branch_entries: ${entries.length}`,
				`- branch_bytes: ${bytes}`,
				`- read_files: ${ops.readFiles.length}`,
				`- modified_files: ${ops.modifiedFiles.length}`,
				`- shell_commands: ${ops.shellCommands.length}`,
				"",
				"Automatic maintenance:",
				`- checkpoint interval ms: ${AUTO_CHECKPOINT_INTERVAL_MS}`,
				`- checkpoint burst bytes: ${AUTO_CHECKPOINT_MAX_NEW_BYTES}`,
				"- compaction: Pi native triggers with data-oriented summary instructions from this extension",
				`- last checkpoint bytes: ${state.lastCheckpointBytes ?? "none"}`,
				"",
				"Campaigns:",
				campaigns,
			].join("\n");
			await sendVisible(pi, ctx, status);
		},
	});

	pi.registerCommand("data-compact", {
		description: "Trigger Pi's native compaction now with optional extra data-oriented instructions",
		handler: async (args, ctx) => {
			ctx.compact({
				customInstructions: dataCompactInstructions(args),
				onComplete: () => {
					void writeTranscript(ctx).catch(() => undefined);
					if (ctx.hasUI) ctx.ui.notify("Data-oriented compaction complete", "info");
				},
				onError: (error: Error) => {
					if (ctx.hasUI) ctx.ui.notify(`Data-oriented compaction failed: ${error.message}`, "error");
					else console.error(`Data-oriented compaction failed: ${error.message}`);
				},
			});
			await sendVisible(pi, ctx, "Started Pi native compaction with data-oriented instructions.");
		},
	});

	pi.registerCommand("data-campaign", {
		description: "Manage file-backed campaigns: /data-campaign [list|new|status|add] ...",
		handler: async (args, ctx) => {
			await handleCampaign(pi, args, ctx);
		},
	});
}
