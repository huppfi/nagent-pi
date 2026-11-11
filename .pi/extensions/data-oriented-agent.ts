import { compact, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ID = "data-oriented-agent";
const ARTIFACT_ROOT = join(".pi", "artifacts", "data-agent");
// Transcripts, branch tails, and machine state can contain secrets from tool output.
const ARTIFACT_GITIGNORE = ["sessions/", "checkpoints/", "state/", ""].join("\n");
const MAX_TRANSCRIPT_TEXT = 12_000;
const CHECKPOINT_TAIL_ENTRIES = 24;
const AUTO_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_CHECKPOINT_MAX_NEW_BYTES = 256 * 1024;
// Operating rules, a short data-oriented design rule set (see nagent-context/README.md),
// injected on every run.
const CONTEXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "nagent-context");
const DOD_RULES_PATH = join(CONTEXT_DIR, "data-oriented-design.md");

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

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

// Write a temp file in the same directory, then rename it over the target: a crash
// or a full disk leaves the old file or the new one, never a truncated one. The
// temp name starts with '.', so directory listings skip it.
async function writeFileAtomic(path: string, content: string): Promise<void> {
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		const handle = await open(temp, "w");
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

// Only a missing file counts as absent; any other read error stops the write
// instead of replacing a file we could not compare against.
async function writeIfChanged(path: string, content: string): Promise<boolean> {
	try {
		if ((await readFile(path, "utf8")) === content) return false;
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	await writeFileAtomic(path, content);
	return true;
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if (isMissing(error)) return -1;
		throw error;
	}
}

function sha1(text: string): string {
	return createHash("sha1").update(text).digest("hex");
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
	// Relative to cwd; listed in the artifact index.
	lastCheckpointPath?: string;
	// What transcript.md holds, so the next export can append instead of rewriting.
	transcript?: {
		headerHash: string;
		entryCount: number;
		lastEntryId: string;
		bytes: number;
	};
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

// Session entries are append-only and never change once written, so each one is
// serialized once per process instead of the whole branch on every run.
const entryBytesById = new Map<string, number>();

function branchBytes(entries: SessionEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		let bytes = entry.id ? entryBytesById.get(entry.id) : undefined;
		if (bytes === undefined) {
			bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
			if (entry.id) entryBytesById.set(entry.id, bytes);
		}
		total += bytes;
	}
	return total;
}

function statePath(ctx: ExtensionContext | ExtensionCommandContext): string {
	return join(stateRoot(ctx.cwd), `${getSessionId(ctx)}.json`);
}

// Only a missing state file means "no state yet". A file that exists but can't be
// read or parsed is reported and left alone, never silently reset and overwritten.
async function readAutoState(ctx: ExtensionContext | ExtensionCommandContext): Promise<AutoState> {
	const path = statePath(ctx);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return {};
		throw error;
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		throw new Error(`cannot parse ${path} (${error instanceof Error ? error.message : String(error)}); fix or delete it`);
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${path} is not a JSON object; fix or delete it`);
	return data as AutoState;
}

async function writeAutoState(ctx: ExtensionContext | ExtensionCommandContext, state: AutoState): Promise<void> {
	await mkdir(stateRoot(ctx.cwd), { recursive: true });
	await writeIfChanged(statePath(ctx), JSON.stringify(state, null, 2) + "\n");
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
		await writeFileAtomic(path, content);
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

// Mutates state; the caller saves it once.
async function runAutomaticMaintenance(ctx: ExtensionContext, state: AutoState): Promise<string[]> {
	const entries = getBranch(ctx);
	const bytes = branchBytes(entries);
	const now = Date.now();
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
		state.lastCheckpointPath = relative(ctx.cwd, checkpoint);
		actions.push(`auto checkpoint: ${relative(ctx.cwd, checkpoint)}`);
	}

	return actions;
}

// Only what can't change while the branch grows, so appending stays valid.
function transcriptHeader(ctx: ExtensionContext | ExtensionCommandContext, entries: SessionEntry[]): string {
	return [
		"# Pi session transcript",
		"",
		`- cwd: ${ctx.cwd}`,
		`- session_file: ${getSessionFile(ctx) ?? "ephemeral"}`,
		"- file operations: `files.md` next to this file",
		"",
		"## First user prompt",
		"",
		firstUserPrompt(entries) || "(none)",
		"",
		"## Transcript",
		"",
		"",
	].join("\n");
}

function transcriptEntries(entries: SessionEntry[]): string {
	return entries
		.map(entryToMarkdown)
		.filter((text): text is string => Boolean(text))
		.map((text) => `---\n\n${text}\n\n`)
		.join("");
}

function fileOpsMarkdown(entries: SessionEntry[]): string {
	const ops = collectFileOps(entries);
	return [
		"# File operations on the current branch",
		"",
		"## Read files",
		ops.readFiles.length ? ops.readFiles.map((p) => `- ${p}`).join("\n") : "(none detected)",
		"",
		"## Modified files",
		ops.modifiedFiles.length ? ops.modifiedFiles.map((p) => `- ${p}`).join("\n") : "(none detected)",
		"",
	].join("\n");
}

// Appends only the entries added since the last export. Pi only appends to a
// branch, so the entries exported last time are a prefix of the current branch
// unless the user moved to another one (/tree, fork): the last exported id at the
// same position proves the prefix (a branch is a root-to-leaf path), and the file
// size proves nobody edited or truncated the file since, including a crash between
// an append and the state save. Anything else rewrites the file in full.
// Mutates state; the caller saves it.
async function writeTranscript(ctx: ExtensionContext | ExtensionCommandContext, state: AutoState): Promise<string> {
	const entries = getBranch(ctx);
	const sessionDir = join(sessionsRoot(ctx.cwd), getSessionId(ctx));
	await mkdir(sessionDir, { recursive: true });
	const transcriptPath = join(sessionDir, "transcript.md");
	await writeIfChanged(join(sessionDir, "files.md"), fileOpsMarkdown(entries));

	const header = transcriptHeader(ctx, entries);
	const headerHash = sha1(header);
	const prev = state.transcript;
	const appendable =
		prev !== undefined &&
		prev.headerHash === headerHash &&
		prev.entryCount <= entries.length &&
		(prev.entryCount === 0 || (prev.lastEntryId !== "" && entries[prev.entryCount - 1]?.id === prev.lastEntryId)) &&
		(await fileSize(transcriptPath)) === prev.bytes;

	let bytes: number;
	if (appendable) {
		const tail = transcriptEntries(entries.slice(prev.entryCount));
		if (tail) await appendFile(transcriptPath, tail, "utf8");
		bytes = prev.bytes + Buffer.byteLength(tail, "utf8");
	} else {
		const content = header + transcriptEntries(entries);
		await writeFileAtomic(transcriptPath, content);
		bytes = Buffer.byteLength(content, "utf8");
	}
	state.transcript = { headerHash, entryCount: entries.length, lastEntryId: entries.at(-1)?.id ?? "", bytes };
	return transcriptPath;
}

// For callers that don't otherwise touch the state file.
async function exportTranscript(ctx: ExtensionContext | ExtensionCommandContext): Promise<string> {
	const state = await readAutoState(ctx);
	const transcript = await writeTranscript(ctx, state);
	await writeAutoState(ctx, state);
	return transcript;
}

async function ensureArtifactGitignore(root: string): Promise<void> {
	await writeFile(join(root, ".gitignore"), ARTIFACT_GITIGNORE, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
}

// The content depends only on the session, the transcript path and the latest
// checkpoint, so it is written when one of those changes, not on every run.
async function writeIndex(ctx: ExtensionContext | ExtensionCommandContext, state: AutoState, transcriptPath: string): Promise<string> {
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
		`- current_session: ${getSessionId(ctx)}`,
		`- latest_transcript: \`${relative(ctx.cwd, transcriptPath)}\``,
		`- latest_checkpoint: ${state.lastCheckpointPath ? `\`${state.lastCheckpointPath}\`` : "(none)"}`,
		"",
		"## Layout",
		"",
		"- `sessions/<session-id>/transcript.md` — export of the current branch, appended after each run",
		"- `sessions/<session-id>/files.md` — files read and modified on the current branch",
		"- `checkpoints/*.md` — user-created restart/checkpoint files",
		"- `campaigns/<slug>/campaign.md` — file-backed long-horizon plans",
		"- `knowledge/*.md` — distilled facts, decisions, file notes, commands, and open questions",
		"",
		"`.gitignore` excludes sessions, checkpoints, and state by default because they can contain secrets from tool output; edit it to commit them.",
		"",
	].join("\n");
	const indexPath = join(root, "README.md");
	await writeIfChanged(indexPath, content);
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
	await writeFileAtomic(checkpointPath, content);
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
		// Never replace an existing campaign: its items are the durable state.
		if ((await fileSize(path)) !== -1) {
			await sendVisible(
				pi,
				ctx,
				`Campaign already exists: ${relative(ctx.cwd, path)} (use /data-campaign status ${slug} or /data-campaign add ${slug} <item>)`,
			);
			return;
		}
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
		await writeFileAtomic(path, content);
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
			await writeFileAtomic(path, `${current.replace(/\s*$/, "\n")}- [ ] ${item}\n`);
			await sendVisible(pi, ctx, `Added item to ${relative(ctx.cwd, path)}: ${item}`);
		} catch {
			await sendVisible(pi, ctx, `Campaign not found: ${rawSlug}`);
		}
		return;
	}

	await sendVisible(pi, ctx, "Usage: /data-campaign [list|new|status|add] ...");
}

// The bash guard catches common accidents. It is a deny list over command text,
// so it is not a security boundary: anything it doesn't recognize (eval, a script
// file, an interpreter) runs unasked.

// `rm -r` without `-f` is just as destructive here: rm only prompts when stdin is a
// terminal, and the agent's shell has none.
function isRecursiveRm(command: string): boolean {
	for (const segment of command.split(/[;&|\n()]+/)) {
		const words = segment.trim().split(/\s+/);
		const rmIndex = words.findIndex((word) => word === "rm" || word.endsWith("/rm"));
		if (rmIndex === -1) continue;
		for (const word of words.slice(rmIndex + 1)) {
			if (word === "--") break;
			if (word === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(word)) return true;
		}
	}
	return false;
}

// One command segment, up to the next separator.
const SEG = String.raw`[^\n;&|]*`;
// `git` plus any global options (-C dir, -c key=value, --no-pager, --git-dir=x), then the subcommand.
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+`;
const RISKY_BASH: Array<[RegExp, string]> = [
	[new RegExp(String.raw`${GIT}reset\s+--hard\b`), "git reset --hard"],
	[new RegExp(String.raw`${GIT}clean\s+-${SEG}f`), "git clean -f"],
	[new RegExp(String.raw`${GIT}checkout\s+(-f\b|--force\b|--(\s|$)|\.(\s|$))`), "git checkout that discards changes"],
	[new RegExp(String.raw`${GIT}restore\b(?!${SEG}--staged)`), "git restore (discards changes)"],
	[new RegExp(String.raw`${GIT}stash\s+(drop|clear)\b`), "git stash drop/clear"],
	[new RegExp(String.raw`${GIT}branch\s+(-D\b|-d\s+-f\b|-f\s+-d\b|--delete\s+--force\b)`), "git branch -D"],
	[new RegExp(String.raw`${GIT}push\b${SEG}(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)`), "git push --force"],
	[new RegExp(String.raw`\bfind\b${SEG}\s(-delete\b|-exec(dir)?\s+(\S*/)?rm\b)`), "find -delete"],
	[new RegExp(String.raw`\bdd\b${SEG}\bof=`), "dd writing to a file or device"],
	[/\b(mkfs(\.\w+)?|wipefs|shred)\b/, "disk/file wiping tool"],
	[/\bsudo\b/, "sudo command"],
	[/(>>?|\btee\b(\s+-a)?)\s*["']?[^\s;|&"']*(\.env\b|\.git\/|\.ssh\/)/, "shell write to .env, .git/ or ~/.ssh/"],
];

function suspiciousBash(command: string): string | undefined {
	if (isRecursiveRm(command)) return "recursive delete";
	return RISKY_BASH.find(([pattern]) => pattern.test(command))?.[1];
}

// --- Temp-folder exemption -------------------------------------------------
// A risky command runs without asking only when it provably touches nothing
// outside a real temp root. Anything the guard can't resolve statically asks.

const PATHS = process.platform === "win32" ? win32 : posix;
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

// Follows symlinks through the longest existing prefix, so `/tmp/link/*` with
// link -> ~/project counts as ~/project. Paths that don't exist yet keep their tail.
function realish(abs: string): string {
	const rest: string[] = [];
	let head = abs;
	for (;;) {
		try {
			return PATHS.join(realpathSync(head), ...rest);
		} catch {
			const parent = PATHS.dirname(head);
			if (parent === head) return abs;
			rest.unshift(PATHS.basename(head));
			head = parent;
		}
	}
}

// Real temp roots only, resolved once. A folder merely named like one
// (~/project-temp-data) is not one. A filesystem root or home never counts.
const TEMP_ROOTS: string[] = (() => {
	const candidates = [tmpdir(), process.env.TMPDIR, process.env.TEMP, process.env.TMP];
	if (process.platform !== "win32") candidates.push("/tmp", "/var/tmp");
	const home = PATHS.resolve(homedir());
	const roots = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate) continue;
		for (const root of [PATHS.resolve(candidate), realish(PATHS.resolve(candidate))]) {
			if (root === PATHS.parse(root).root || root === home) continue;
			roots.add(FOLD_CASE ? root.toLowerCase() : root);
		}
	}
	return [...roots];
})();

// Strictly inside a temp root: deleting the root itself still asks.
function insideTemp(abs: string): boolean {
	const real = realish(abs);
	const path = FOLD_CASE ? real.toLowerCase() : real;
	return TEMP_ROOTS.some((root) => {
		const rel = PATHS.relative(root, path);
		return rel !== "" && !rel.startsWith("..") && !PATHS.isAbsolute(rel);
	});
}

const TEMP_VAR = /^(\$TMPDIR|\$\{TMPDIR\}|\$TEMP|\$\{TEMP\}|\$TMP|\$\{TMP\}|%TEMP%|%TMP%|\$env:TEMP|\$env:TMP)(?=$|[\\/])/i;

// A command word as an absolute path, or undefined when the shell would still
// expand it ($VAR, ~user, `cmd`, braces) or it is relative to an unknown folder.
function staticPath(word: string, dir: string | undefined): string | undefined {
	let path = word.replace(TEMP_VAR, () => tmpdir());
	if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
	if (/[$`%~!{}()]/.test(path)) return undefined;
	if (!PATHS.isAbsolute(path)) {
		if (!dir) return undefined;
		path = PATHS.join(dir, path);
	}
	return PATHS.resolve(path);
}

function commandWords(part: string): string[] {
	return (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, ""));
}

// Git subcommands whose damage stays inside the working tree.
const LOCAL_GIT = new Set(["reset", "clean", "checkout", "restore", "stash", "branch"]);

function partOnlyTouchesTemp(words: string[], dir: string | undefined): boolean {
	const temp = (word: string) => {
		const path = staticPath(word, dir);
		return path !== undefined && insideTemp(path);
	};
	const program = words[0] ?? "";
	if (program === "rm" || program.endsWith("/rm")) {
		const dashes = words.indexOf("--");
		const targets = words.slice(1).filter((word, i) => (dashes !== -1 && i + 1 > dashes) || !word.startsWith("-"));
		return targets.length > 0 && targets.every(temp);
	}
	if (program === "find") {
		const end = words.findIndex((word, i) => i > 0 && /^[-(!]/.test(word));
		const roots = words.slice(1, end === -1 ? undefined : end);
		return (roots.length ? roots : ["."]).every(temp);
	}
	// `git -C x`, `GIT_DIR=x git`, `sudo git` never reach this: words[1] must be the
	// subcommand itself, and the folder it runs in must be a known temp folder.
	if (program === "git" && LOCAL_GIT.has(words[1] ?? "")) {
		return dir !== undefined && insideTemp(dir);
	}
	return false; // sudo, push, dd, redirections, ...: always ask
}

// Every risky part of the command only touches temp folders. Relative paths count
// from the last `cd` (or the session's folder). Pipes, subshells, command
// substitution and background jobs make the folder or the targets unknowable
// here, so they always ask.
function onlyTouchesTemp(command: string, cwd: string): boolean {
	if (/[|`(){}]|\$\(|<\(/.test(command) || /(^|[^&>])&(?![&>])/.test(command)) return false;
	let dir: string | undefined = PATHS.resolve(cwd);
	for (const part of command.split(/&&|;|\n/)) {
		const words = commandWords(part.trim());
		if (words[0] === "cd") {
			dir = words[1] && words[1] !== "-" ? staticPath(words[1], dir) : undefined;
			continue;
		}
		if (words[0] === "pushd" || words[0] === "popd") dir = undefined;
		if (!suspiciousBash(part)) continue;
		if (!partOnlyTouchesTemp(words, dir)) return false;
	}
	return true;
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

	// Read once at load and kept byte-identical across runs so the section stays in
	// the cached prompt prefix. A missing file disables only the rules, never the guards.
	let dodRules: string | undefined;
	let dodRulesError: string | undefined;
	const dodRulesLoaded = readFile(DOD_RULES_PATH, "utf8").then(
		(text) => {
			dodRules = text.trim();
		},
		(error: unknown) => {
			dodRulesError = error instanceof Error ? error.message : String(error);
		},
	);

	pi.on("session_shutdown", async () => {
		globalState.__dataOrientedAgentLoaded = false;
		entryBytesById.clear();
	});

	pi.on("session_start", async (_event, ctx) => {
		await dodRulesLoaded;
		if (ctx.hasUI) {
			ctx.ui.setStatus(EXTENSION_ID, dodRules ? "data artifacts on · DOD rules on" : "data artifacts on · DOD rules MISSING");
			if (dodRulesError) ctx.ui.notify(`Data-oriented design rules not loaded: ${dodRulesError}`, "warning");
		} else if (dodRulesError) {
			console.error(`Data-oriented design rules not loaded: ${dodRulesError}`);
		}
	});

	pi.on("before_agent_start", async (event) => {
		await dodRulesLoaded;
		if (dodRules) event.systemPromptOptions.sections.data_oriented_design = dodRules;
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
			const state = await readAutoState(ctx);
			const transcript = await writeTranscript(ctx, state);
			const maintenance = await runAutomaticMaintenance(ctx, state);
			await writeIndex(ctx, state, transcript);
			await writeAutoState(ctx, state);
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
			if (!reason || onlyTouchesTemp(event.input.command, ctx.cwd)) return undefined;
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
			const state = await readAutoState(ctx);
			const transcript = await writeTranscript(ctx, state);
			const index = await writeIndex(ctx, state, transcript);
			await writeAutoState(ctx, state);
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
			const state = await readAutoState(ctx);
			const transcript = await writeTranscript(ctx, state);
			const checkpoint = await writeCheckpoint(ctx, args.trim());
			state.lastCheckpointPath = relative(ctx.cwd, checkpoint);
			await writeIndex(ctx, state, transcript);
			await writeAutoState(ctx, state);
			await sendVisible(pi, ctx, `Checkpoint written: ${relative(ctx.cwd, checkpoint)}`);
			await report(ctx, "Data checkpoint written");
		},
	});

	pi.registerCommand("data-distill", {
		description: "Harvest current Pi branch into nagent-style knowledge files under .pi/artifacts/data-agent/knowledge/",
		handler: async (_args, ctx) => {
			const state = await readAutoState(ctx);
			const transcript = await writeTranscript(ctx, state);
			const written = await writeDistill(ctx);
			await writeIndex(ctx, state, transcript);
			await writeAutoState(ctx, state);
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
			let state: AutoState = {};
			let stateError: string | undefined;
			try {
				state = await readAutoState(ctx);
			} catch (error) {
				stateError = error instanceof Error ? error.message : String(error);
			}
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
				`- dod_rules: ${dodRules ? `injected (${Buffer.byteLength(dodRules, "utf8")} bytes) from ${DOD_RULES_PATH}` : `MISSING (${dodRulesError ?? "not loaded"})`}`,
				"",
				"Automatic maintenance:",
				`- checkpoint interval ms: ${AUTO_CHECKPOINT_INTERVAL_MS}`,
				`- checkpoint burst bytes: ${AUTO_CHECKPOINT_MAX_NEW_BYTES}`,
				"- compaction: Pi native triggers with data-oriented summary instructions from this extension",
				`- last checkpoint bytes: ${state.lastCheckpointBytes ?? "none"}`,
				`- last checkpoint: ${state.lastCheckpointPath ?? "none"}`,
				...(stateError ? [`- STATE FILE UNREADABLE: ${stateError}`] : []),
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
					void exportTranscript(ctx).catch(() => undefined);
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
