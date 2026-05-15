import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { basename } from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

type SemanticColor =
	| "model"
	| "shellMode"
	| "path"
	| "gitDirty"
	| "gitClean"
	| "thinking"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "context"
	| "contextWarn"
	| "contextError"
	| "cost"
	| "tokens"
	| "separator"
	| "border";
type ColorScheme = Partial<Record<SemanticColor, ThemeColor>>;

type BuiltinSegmentId =
	| "model"
	| "shell_mode"
	| "path"
	| "git"
	| "subagents"
	| "token_in"
	| "token_out"
	| "token_total"
	| "cost"
	| "context_pct"
	| "context_total"
	| "time_spent"
	| "time"
	| "session"
	| "hostname"
	| "cache_read"
	| "thinking"
	| "extension_statuses";
type SeparatorStyle =
	| "powerline"
	| "powerline-thin"
	| "slash"
	| "pipe"
	| "block"
	| "none"
	| "ascii"
	| "dot"
	| "chevron"
	| "star";
type PresetName =
	| "default"
	| "minimal"
	| "compact"
	| "full"
	| "nerd"
	| "ascii"
	| "custom";

interface GitStatus {
	branch: string | null;
	staged: number;
	unstaged: number;
	untracked: number;
}
interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}
interface SegmentCtx {
	model:
		| { id: string; name?: string; reasoning?: boolean; contextWindow?: number }
		| undefined;
	thinkingLevel: string;
	sessionId: string | undefined;
	cwd?: string;
	usageStats: UsageStats;
	contextPercent: number;
	contextWindow: number;
	autoCompactEnabled: boolean;
	usingSubscription: boolean;
	sessionStartTime: number;
	git: GitStatus;
	extensionStatuses: ReadonlyMap<string, string>;
	options: Record<string, any>;
	theme: Theme;
	colors: ColorScheme;
}
interface RenderedSeg {
	content: string;
	visible: boolean;
}
interface SegmentDef {
	id: BuiltinSegmentId;
	render(ctx: SegmentCtx): RenderedSeg;
}
interface Preset {
	leftSegments: BuiltinSegmentId[];
	rightSegments: BuiltinSegmentId[];
	secondarySegments?: BuiltinSegmentId[];
	separator: SeparatorStyle;
	segmentOptions?: Record<string, any>;
	colors?: ColorScheme;
}
interface SepDef {
	left: string;
	right: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ANSI / Color
// ═══════════════════════════════════════════════════════════════════════════

const ansi = {
	reset: "\x1b[0m",
	fg: (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`,
	fg256: (c: number) => `\x1b[38;5;${c}m`,
};

function hexAnsi(hex: string): string {
	const h = hex.replace("#", "");
	return ansi.fg(
		parseInt(h.slice(0, 2), 16),
		parseInt(h.slice(2, 4), 16),
		parseInt(h.slice(4, 6), 16),
	);
}

const COLOR_SEP_ANSI = ansi.fg256(244);

// ═══════════════════════════════════════════════════════════════════════════
// Theme
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_COLORS: Required<ColorScheme> = {
	model: "mdCodeBlock",
	shellMode: "accent",
	path: "accent",
	gitDirty: "warning",
	gitClean: "success",
	thinking: "thinkingOff",
	thinkingMinimal: "thinkingMinimal",
	thinkingLow: "thinkingLow",
	thinkingMedium: "thinkingMedium",
	context: "dim",
	contextWarn: "warning",
	contextError: "error",
	cost: "text",
	tokens: "muted",
	separator: "dim",
	border: "borderMuted",
};

const RAINBOW = [
	"#b281d6",
	"#d787af",
	"#febc38",
	"#e4c00f",
	"#89d281",
	"#00afaf",
	"#178fb9",
	"#b281d6",
];

function applyColor(theme: Theme, color: string, text: string): string {
	if (/^#[0-9a-fA-F]{6}$/.test(color)) return `${hexAnsi(color)}${text}\x1b[0m`;
	try {
		return theme.fg(color as any, text);
	} catch {
		return theme.fg("text", text);
	}
}

function fgColor(
	theme: Theme,
	sem: SemanticColor,
	text: string,
	colors?: ColorScheme,
): string {
	return applyColor(
		theme,
		colors?.[sem] ?? DEFAULT_COLORS[sem] ?? "#FFFFFF",
		text,
	);
}

function rainbow(text: string): string {
	let r = "",
		i = 0;
	for (const c of text) {
		if (c === " " || c === ":") r += c;
		else {
			r += hexAnsi(RAINBOW.at(i % RAINBOW.length) ?? "#b281d6") + c;
			i++;
		}
	}
	return r + ansi.reset;
}

// ═══════════════════════════════════════════════════════════════════════════
// Icons
// ═══════════════════════════════════════════════════════════════════════════

const SEP_DOT = " · ";

interface IconSet {
	model: string;
	folder: string;
	branch: string;
	git: string;
	tokens: string;
	context: string;
	cost: string;
	time: string;
	cache: string;
	input: string;
	output: string;
	host: string;
	session: string;
	auto: string;
	warning: string;
}

function hasNerdFonts(): boolean {
	if (process.env.POWERLINE_NERD_FONTS === "1") return true;
	if (process.env.POWERLINE_NERD_FONTS === "0") return false;
	if (process.env.GHOSTTY_RESOURCES_DIR) return true;
	const t = (process.env.TERM_PROGRAM || "").toLowerCase();
	return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some((s) =>
		t.includes(s),
	);
}

function getIcons(): IconSet {
	if (!hasNerdFonts())
		return {
			model: "",
			folder: "dir",
			branch: "⎇",
			git: "⎇",
			tokens: "⊛",
			context: "◫",
			cost: "$",
			time: "◷",
			cache: "cache",
			input: "in:",
			output: "out:",
			host: "host",
			session: "id",
			auto: "AC",
			warning: "!",
		};
	return {
		model: "\uEC19",
		folder: "\uF115",
		branch: "\uF126",
		git: "\uF1D3",
		tokens: "\uE26B",
		context: "\uE70F",
		cost: "\uF155",
		time: "\uF017",
		cache: "\uF1C0",
		input: "\uF090",
		output: "\uF08B",
		host: "\uF109",
		session: "\uF550",
		auto: "\u{F0068}",
		warning: "\uF071",
	};
}

function sepChar(style: SeparatorStyle): SepDef {
	const nf = hasNerdFonts();
	switch (style) {
		case "powerline":
			return { left: nf ? "\uE0B0" : ">", right: nf ? "\uE0B2" : "<" };
		case "powerline-thin":
			return { left: nf ? "\uE0B1" : "|", right: nf ? "\uE0B3" : "|" };
		case "slash":
			return { left: " / ", right: " / " };
		case "pipe":
			return { left: " | ", right: " | " };
		case "block":
			return { left: "█", right: "█" };
		case "none":
			return { left: " ", right: " " };
		case "ascii":
			return { left: ">", right: "<" };
		case "dot":
			return { left: "·", right: "·" };
		case "chevron":
			return { left: "›", right: "‹" };
		case "star":
			return { left: "✦", right: "✦" };
		default:
			return { left: "|", right: "|" };
	}
}

function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}

// ═══════════════════════════════════════════════════════════════════════════
// Git
// ═══════════════════════════════════════════════════════════════════════════

let _gitSt: { s: number; u: number; ut: number; ts: number } | null = null;
let _gitBr: { b: string | null; ts: number } | null = null;
let _gitPf: Promise<void> | null = null;
let _gitBf: Promise<void> | null = null;
const _gitIv = 0,
	_gitBiv = 0;

function runGit(args: string[], ms = 200): Promise<string | null> {
	return new Promise((r) => {
		const p = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "",
			done = false;
		const fin = (res: string | null) => {
			if (!done) {
				done = true;
				clearTimeout(t);
				r(res);
			}
		};
		p.stdout.on("data", (d: any) => (out += d.toString()));
		p.on("close", (c: number | null) => fin(c === 0 ? out.trim() : null));
		p.on("error", () => fin(null));
		const t = setTimeout(() => {
			p.kill();
			fin(null);
		}, ms);
	});
}

function getGitBranch(): string | null {
	const now = Date.now();
	if (_gitBr && now - _gitBr.ts < 500) return _gitBr.b;
	if (!_gitBf) {
		const fid = _gitBiv;
		_gitBf = runGit(["branch", "--show-current"]).then(async (b) => {
			if (fid !== _gitBiv) return;
			if (b) {
				_gitBr = { b, ts: Date.now() };
				_gitBf = null;
				return;
			}
			const sha = await runGit(["rev-parse", "--short", "HEAD"]);
			_gitBr = { b: sha ? `${sha} (detached)` : "detached", ts: Date.now() };
			_gitBf = null;
		});
	}
	return _gitBr?.b ?? null;
}

function getGitStatus(providerBranch: string | null): GitStatus {
	const now = Date.now();
	const branch = getGitBranch() ?? providerBranch;
	if (_gitSt && now - _gitSt.ts < 1000)
		return {
			branch,
			staged: _gitSt.s,
			unstaged: _gitSt.u,
			untracked: _gitSt.ut,
		};
	if (!_gitPf) {
		const fid = _gitIv;
		_gitPf = runGit(["status", "--porcelain"], 500).then((r) => {
			if (fid !== _gitIv) return;
			if (r === null) {
				_gitSt = { s: 0, u: 0, ut: 0, ts: Date.now() };
				_gitPf = null;
				return;
			}
			let s = 0,
				u = 0,
				ut = 0;
			for (const l of r.split("\n")) {
				if (!l) continue;
				if (l[0] === "?" && l[1] === "?") {
					ut++;
					continue;
				}
				if (l[0] && l[0] !== " " && l[0] !== "?") s++;
				if (l[1] && l[1] !== " ") u++;
			}
			_gitSt = { s, u, ut, ts: Date.now() };
			_gitPf = null;
		});
	}
	if (_gitSt)
		return {
			branch,
			staged: _gitSt.s,
			unstaged: _gitSt.u,
			untracked: _gitSt.ut,
		};
	return { branch, staged: 0, unstaged: 0, untracked: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
// Context usage
// ═══════════════════════════════════════════════════════════════════════════

function readContextUsage(
	ctx: any,
): { tokens: number; window: number; pct: number } | null {
	if (typeof ctx?.getContextUsage !== "function") return null;
	const u = ctx.getContextUsage();
	if (
		!u ||
		typeof u.tokens !== "number" ||
		typeof u.contextWindow !== "number" ||
		u.contextWindow <= 0
	)
		return null;
	const pct =
		typeof u.percent === "number"
			? u.percent
			: (u.tokens / u.contextWindow) * 100;
	return { tokens: u.tokens, window: u.contextWindow, pct };
}

// ═══════════════════════════════════════════════════════════════════════════
// Presets
// ═══════════════════════════════════════════════════════════════════════════

const PRESETS: Record<PresetName, Preset> = {
	default: {
		leftSegments: [
			"model",
			"thinking",
			"shell_mode",
			"path",
			"git",
			"context_pct",
			"cache_read",
			"cost",
		],
		rightSegments: [],
		secondarySegments: ["extension_statuses"],
		separator: "powerline-thin",
		colors: DEFAULT_COLORS,
		segmentOptions: {
			model: { showThinkingLevel: false },
			path: { mode: "basename" },
			git: {
				showBranch: true,
				showStaged: true,
				showUnstaged: true,
				showUntracked: true,
			},
		},
	},
	minimal: {
		leftSegments: ["shell_mode", "path", "git"],
		rightSegments: ["context_pct"],
		separator: "slash",
		colors: { ...DEFAULT_COLORS, model: "text", path: "text", gitClean: "dim" },
		segmentOptions: {
			path: { mode: "basename" },
			git: {
				showBranch: true,
				showStaged: false,
				showUnstaged: false,
				showUntracked: false,
			},
		},
	},
	compact: {
		leftSegments: ["model", "shell_mode", "git"],
		rightSegments: ["cost", "context_pct"],
		separator: "powerline-thin",
		colors: DEFAULT_COLORS,
		segmentOptions: {
			model: { showThinkingLevel: false },
			git: {
				showBranch: true,
				showStaged: true,
				showUnstaged: true,
				showUntracked: false,
			},
		},
	},
	full: {
		leftSegments: [
			"hostname",
			"model",
			"thinking",
			"shell_mode",
			"path",
			"git",
			"subagents",
		],
		rightSegments: [
			"token_in",
			"token_out",
			"cache_read",
			"cost",
			"context_pct",
			"time_spent",
			"time",
			"extension_statuses",
		],
		separator: "powerline",
		colors: DEFAULT_COLORS,
		segmentOptions: {
			model: { showThinkingLevel: false },
			path: { mode: "abbreviated", maxLength: 50 },
			git: {
				showBranch: true,
				showStaged: true,
				showUnstaged: true,
				showUntracked: true,
			},
			time: { format: "24h", showSeconds: false },
		},
	},
	nerd: {
		leftSegments: [
			"hostname",
			"model",
			"thinking",
			"shell_mode",
			"path",
			"git",
			"session",
			"subagents",
		],
		rightSegments: [
			"token_in",
			"token_out",
			"cache_read",
			"cost",
			"context_pct",
			"context_total",
			"time_spent",
			"time",
			"extension_statuses",
		],
		separator: "powerline",
		colors: {
			...DEFAULT_COLORS,
			model: "accent",
			path: "success",
			tokens: "muted",
			cost: "warning",
		},
		segmentOptions: {
			model: { showThinkingLevel: false },
			path: { mode: "abbreviated", maxLength: 60 },
			git: {
				showBranch: true,
				showStaged: true,
				showUnstaged: true,
				showUntracked: true,
			},
			time: { format: "24h", showSeconds: true },
		},
	},
	ascii: {
		leftSegments: ["model", "shell_mode", "path", "git"],
		rightSegments: ["token_total", "cost", "context_pct"],
		separator: "ascii",
		colors: { ...DEFAULT_COLORS, model: "text", path: "text", gitClean: "dim" },
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { mode: "abbreviated", maxLength: 40 },
			git: {
				showBranch: true,
				showStaged: true,
				showUnstaged: true,
				showUntracked: true,
			},
		},
	},
	custom: {
		leftSegments: ["model", "shell_mode", "path", "git"],
		rightSegments: ["token_total", "cost", "context_pct"],
		separator: "powerline-thin",
		colors: DEFAULT_COLORS,
		segmentOptions: {},
	},
};

function getPreset(name: PresetName): Preset {
	return PRESETS[name] ?? PRESETS.default;
}

// ═══════════════════════════════════════════════════════════════════════════
// Segments
// ═══════════════════════════════════════════════════════════════════════════

function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1e6) return `${Math.round(n / 1000)}k`;
	if (n < 1e7) return `${(n / 1e6).toFixed(1)}M`;
	return `${Math.round(n / 1e6)}M`;
}
function fmtDur(ms: number): string {
	const s = Math.floor(ms / 1000),
		m = Math.floor(s / 60),
		h = Math.floor(m / 60);
	if (h > 0) return `${h}h${m % 60}m`;
	if (m > 0) return `${m}m${s % 60}s`;
	return `${s}s`;
}

const SEGMENTS: Record<BuiltinSegmentId, SegmentDef> = {
	model: {
		id: "model",
		render(ctx) {
			const ic = getIcons();
			let n = ctx.model?.name || ctx.model?.id || "no-model";
			if (n.startsWith("Claude ")) n = n.slice(7);
			let c = withIcon(ic.model, n);
			const o = ctx.options.model ?? {};
			if (
				o.showThinkingLevel !== false &&
				ctx.model?.reasoning &&
				ctx.thinkingLevel !== "off"
			) {
				const t = ctx.thinkingLevel;
				const m: Record<string, string> = {
					minimal: hasNerdFonts() ? "\u{F0E7} min" : "[min]",
					low: hasNerdFonts() ? "\u{F10C} low" : "[low]",
					medium: hasNerdFonts() ? "\u{F192} med" : "[med]",
					high: hasNerdFonts() ? "\u{F111} high" : "[high]",
					xhigh: hasNerdFonts() ? "\u{F06D} xhi" : "[xhi]",
				};
				if (m[t]) c += `${SEP_DOT}${m[t]}`;
			}
			return {
				content: fgColor(ctx.theme, "model", c, ctx.colors),
				visible: true,
			};
		},
	},
	shell_mode: {
		id: "shell_mode",
		render() {
			return { content: "", visible: false };
		},
	},
	path: {
		id: "path",
		render(ctx) {
			const ic = getIcons();
			let p = ctx.cwd ?? process.cwd();
			const home = process.env.HOME || process.env.USERPROFILE;
			if (home && p.startsWith(home)) p = `~${p.slice(home.length)}`;
			return {
				content: fgColor(
					ctx.theme,
					"path",
					withIcon(ic.folder, basename(p) || p),
					ctx.colors,
				),
				visible: true,
			};
		},
	},
	git: {
		id: "git",
		render(ctx) {
			const ic = getIcons();
			const o = ctx.options.git ?? {};
			const { branch, staged: s, unstaged: u, untracked: ut } = ctx.git;
			const status = s > 0 || u > 0 || ut > 0 ? { s, u, ut } : null;
			if (!branch && !status) return { content: "", visible: false };
			const dirty = !!(
				status &&
				(status.s > 0 || status.u > 0 || status.ut > 0)
			);
			const bc: SemanticColor = dirty ? "gitDirty" : "gitClean";
			let c = "";
			if (o.showBranch !== false && branch)
				c = fgColor(ctx.theme, bc, withIcon(ic.branch, branch), ctx.colors);
			if (status) {
				const parts: string[] = [];
				if (o.showUnstaged !== false && status.u > 0)
					parts.push(applyColor(ctx.theme, "warning", `*${status.u}`));
				if (o.showStaged !== false && status.s > 0)
					parts.push(applyColor(ctx.theme, "success", `+${status.s}`));
				if (o.showUntracked !== false && status.ut > 0)
					parts.push(applyColor(ctx.theme, "muted", `?${status.ut}`));
				if (parts.length) c += c ? ` ${parts.join(" ")}` : parts.join(" ");
			}
			if (!c) return { content: "", visible: false };
			return { content: c, visible: true };
		},
	},
	thinking: {
		id: "thinking",
		render(ctx) {
			const l = ctx.thinkingLevel || "off";
			const m: Record<string, string> = {
				off: "off",
				minimal: "min",
				low: "low",
				medium: "med",
				high: "high",
				xhigh: "xhigh",
			};
			const t = `think:${m[l] || l}`;
			if (l === "high" || l === "xhigh")
				return { content: rainbow(t), visible: true };
			const sm: Record<string, SemanticColor> = {
				minimal: "thinkingMinimal",
				low: "thinkingLow",
				medium: "thinkingMedium",
			};
			return {
				content: fgColor(ctx.theme, sm[l] || "thinking", t, ctx.colors),
				visible: true,
			};
		},
	},
	subagents: {
		id: "subagents",
		render() {
			return { content: "", visible: false };
		},
	},
	token_in: {
		id: "token_in",
		render(ctx) {
			if (!ctx.usageStats.input) return { content: "", visible: false };
			return {
				content: fgColor(
					ctx.theme,
					"tokens",
					withIcon(getIcons().input, fmtTok(ctx.usageStats.input)),
					ctx.colors,
				),
				visible: true,
			};
		},
	},
	token_out: {
		id: "token_out",
		render(ctx) {
			if (!ctx.usageStats.output) return { content: "", visible: false };
			return {
				content: fgColor(
					ctx.theme,
					"tokens",
					withIcon(getIcons().output, fmtTok(ctx.usageStats.output)),
					ctx.colors,
				),
				visible: true,
			};
		},
	},
	token_total: {
		id: "token_total",
		render(ctx) {
			const { input, output, cacheRead } = ctx.usageStats;
			if (!(input + output + cacheRead))
				return { content: "", visible: false };
			return {
				content: fgColor(
					ctx.theme,
					"tokens",
					withIcon(
						getIcons().tokens,
						fmtTok(input + output + cacheRead),
					),
					ctx.colors,
				),
				visible: true,
			};
		},
	},
	cost: {
		id: "cost",
		render(ctx) {
			const { cost } = ctx.usageStats;
			if (!cost && !ctx.usingSubscription)
				return { content: "", visible: false };
			return {
				content: fgColor(
					ctx.theme,
					"cost",
					ctx.usingSubscription ? "[sub]" : `$${cost.toFixed(2)}`,
					ctx.colors,
				),
				visible: true,
			};
		},
	},
	context_pct: {
		id: "context_pct",
		render(ctx) {
			const ic = getIcons();
			const p = ctx.contextPercent,
				w = ctx.contextWindow;
			const t = `${p.toFixed(1)}%/${fmtTok(w)}${ctx.autoCompactEnabled && ic.auto ? ` ${ic.auto}` : ""}`;
			const sm: SemanticColor =
				p > 90 ? "contextError" : p > 70 ? "contextWarn" : "context";
			return {
				content: fgColor(ctx.theme, sm, t, ctx.colors),
				visible: true,
			};
		},
	},
	context_total: {
		id: "context_total",
		render(ctx) {
			if (!ctx.contextWindow) return { content: "", visible: false };
			return {
				content: fgColor(
					ctx.theme,
					"context",
					withIcon(getIcons().context, fmtTok(ctx.contextWindow)),
					ctx.colors,
				),
				visible: true,
			};
		},
	},
	time_spent: {
		id: "time_spent",
		render(ctx) {
			const e = Date.now() - ctx.sessionStartTime;
			if (e < 1000) return { content: "", visible: false };
			return { content: withIcon(getIcons().time, fmtDur(e)), visible: true };
		},
	},
	time: {
		id: "time",
		render(ctx) {
			const o = ctx.options.time ?? {};
			const n = new Date();
			let h = n.getHours();
			let sf = "";
			if (o.format === "12h") {
				sf = h >= 12 ? "pm" : "am";
				h = h % 12 || 12;
			}
			let s = `${h}:${n.getMinutes().toString().padStart(2, "0")}`;
			if (o.showSeconds) s += `:${n.getSeconds().toString().padStart(2, "0")}`;
			return { content: withIcon(getIcons().time, s + sf), visible: true };
		},
	},
	session: {
		id: "session",
		render(ctx) {
			return {
				content: withIcon(
					getIcons().session,
					ctx.sessionId?.slice(0, 8) || "new",
				),
				visible: true,
			};
		},
	},
	hostname: {
		id: "hostname",
		render() {
			return {
				content: withIcon(
					getIcons().host,
					osHostname().split(".")[0] ?? osHostname(),
				),
				visible: true,
			};
		},
	},
	cache_read: {
		id: "cache_read",
		render(ctx) {
			const ic = getIcons();
			return {
				content: fgColor(
					ctx.theme,
					"tokens",
					[ic.cache, fmtTok(ctx.usageStats.cacheRead)]
						.filter(Boolean)
						.join(" "),
					ctx.colors,
				),
				visible: true,
			};
		},
	},
	extension_statuses: {
		id: "extension_statuses",
		render(ctx) {
			const st = ctx.extensionStatuses;
			if (!st || st.size === 0) return { content: "", visible: false };
			const parts: string[] = [];
			for (const v of st.values()) {
				if (!v) continue;
				const s = v.replace(/(\x1b\[[0-9;]*m|\s|·|[|])+$/, "");
				if (visibleWidth(s) > 0) parts.push(s);
			}
			if (!parts.length) return { content: "", visible: false };
			return { content: parts.join(` ${SEP_DOT} `), visible: true };
		},
	},
};

function renderSegment(id: string, ctx: SegmentCtx): RenderedSeg {
	const seg = SEGMENTS[id as BuiltinSegmentId];
	if (!seg) return { content: "", visible: false };
	return seg.render(ctx);
}

// ═══════════════════════════════════════════════════════════════════════════
// Layout
// ═══════════════════════════════════════════════════════════════════════════

function computeLayout(ctx: SegmentCtx, preset: Preset, width: number) {
	const sep = sepChar(preset.separator);
	const sepW = visibleWidth(sep.left) + 2;
	const all = [
		...preset.leftSegments,
		...preset.rightSegments,
		...(preset.secondarySegments ?? []),
	];

	const rendered: { c: string; w: number }[] = [];
	for (const id of all) {
		const r = renderSegment(id, ctx);
		if (r.visible && r.content)
			rendered.push({ c: r.content, w: visibleWidth(r.content) });
	}
	if (!rendered.length) return { top: "", secondary: "" };

	let cw = 2;
	const top: string[] = [];
	const over: typeof rendered = [];
	let ov = false;
	for (const r of rendered) {
		const n = r.w + (top.length ? sepW : 0);
		if (!ov && cw + n <= width) {
			top.push(r.c);
			cw += n;
		} else {
			ov = true;
			over.push(r);
		}
	}
	let sw = 2;
	const sec: string[] = [];
	for (const r of over) {
		const n = r.w + (sec.length ? sepW : 0);
		if (sw + n <= width) {
			sec.push(r.c);
			sw += n;
		} else break;
	}

	const fmt = (parts: string[]) =>
		parts.length
			? " " +
				parts.join(` ${COLOR_SEP_ANSI}${sep.left}${ansi.reset} `) +
				ansi.reset +
				" "
			: "";
	return { top: fmt(top), secondary: fmt(sec) };
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension Entry
// ═══════════════════════════════════════════════════════════════════════════

export default function footer(pi: ExtensionAPI) {
	let footerData: ReadonlyFooterDataProvider | null = null;
	let tui: any = null;
	let ctx: any = null;
	let sessionStart = Date.now();
	let streaming = false;
	let liveUsage: AssistantMessage["usage"] | null = null;
	let getThinking: (() => string) | null = null;
	let curThinking: string | null = null;
	let lw = 0,
		lr: { top: string; secondary: string } | null = null,
		lt = 0,
		dirty = true;

	const scheduleRender = (() => {
		let t: ReturnType<typeof setTimeout> | null = null;
		return (ms = 33) => {
			if (!t)
				t = setTimeout(() => {
					t = null;
					tui?.requestRender();
				}, ms);
		};
	})();

	const reset = () => {
		lr = null;
		dirty = true;
	};
	const render = () => {
		dirty = true;
		scheduleRender();
	};

	const buildCtx = (theme: Theme): SegmentCtx => {
		if (!ctx) throw new Error("no ctx");
		const p = getPreset("default");
		let input = 0,
			output = 0,
			cR = 0,
			cW = 0,
			cost = 0,
			tl: string | null = null,
			lastCR = 0;
		const events = ctx.sessionManager?.getBranch?.() ?? [];
		for (const e of events) {
			if (typeof e !== "object" || e === null || Array.isArray(e)) continue;
			if (
				e.type === "thinking_level_change" &&
				typeof e.thinkingLevel === "string"
			)
				tl = e.thinkingLevel;
			if (
				e.type !== "message" ||
				typeof e.message !== "object" ||
				e.message === null
			)
				continue;
			const m = e.message;
			if (m.role !== "assistant") continue;
			const u = m.usage;
			if (typeof u !== "object" || u === null) continue;
			if (
				typeof u.input !== "number" ||
				typeof u.output !== "number" ||
				typeof u.cacheRead !== "number" ||
				typeof u.cacheWrite !== "number"
			)
				continue;
			if (m.stopReason === "error" || m.stopReason === "aborted") continue;
			input += u.input;
			output += u.output;
			cR = u.cacheRead;
			if (
				typeof u.cost === "object" &&
				u.cost !== null &&
				typeof u.cost.total === "number"
			)
				cost += u.cost.total;
		}

		const cu = readContextUsage(ctx);
		const cTokens =
			cu?.tokens ??
			(liveUsage
				? liveUsage.input +
					liveUsage.output +
					liveUsage.cacheRead +
					liveUsage.cacheWrite
				: 0);
		const cWindow = cu?.window ?? ctx.model?.contextWindow ?? 0;
		const cPct = cu?.pct ?? (cWindow > 0 ? (cTokens / cWindow) * 100 : 0);

		return {
			model: ctx.model,
			thinkingLevel: curThinking ?? tl ?? getThinking?.() ?? "off",
			sessionId: ctx.sessionManager?.getSessionId?.(),
			cwd: ctx.cwd,
			usageStats: {
				input,
				output,
				cacheRead: cR,
				cost,
			},
			contextPercent: cPct,
			contextWindow: cWindow,
			autoCompactEnabled:
				ctx.settingsManager?.getCompactionSettings?.()?.enabled ?? true,
			usingSubscription: ctx.model
				? (ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false)
				: false,
			sessionStartTime: sessionStart,
			git: getGitStatus(footerData?.getGitBranch() ?? null),
			extensionStatuses: footerData?.getExtensionStatuses() ?? new Map(),
			options: p.segmentOptions ?? {},
			theme,
			colors: p.colors ?? DEFAULT_COLORS,
		};
	};

	const getLayout = (width: number, theme: Theme) => {
		const now = Date.now();
		if (lr && lw === width && !dirty && now - lt < (streaming ? 1000 : 250))
			return lr;
		const segCtx = buildCtx(theme);
		lw = width;
		lr = computeLayout(segCtx, getPreset("default"), width);
		lt = now;
		dirty = false;
		return lr;
	};

	pi.on("session_start", async (_e, c) => {
		sessionStart = Date.now();
		ctx = c;
		streaming = false;
		liveUsage = null;
		getThinking = () => pi.getThinkingLevel();
		curThinking = pi.getThinkingLevel();
		if (!c.hasUI) return;

		c.ui.setFooter((t: any, _th: Theme, fd: ReadonlyFooterDataProvider) => {
			footerData = fd;
			tui = t;
			const wf = fd as any;
			const origSet = wf.setExtensionStatus?.bind?.(wf);
			if (typeof origSet === "function")
				wf.setExtensionStatus = (k: string, v: string | undefined) => {
					origSet(k, v);
					reset();
					tui?.requestRender();
				};
			const origClr = wf.clearExtensionStatuses?.bind?.(wf);
			if (typeof origClr === "function")
				wf.clearExtensionStatuses = () => {
					origClr();
					reset();
					tui?.requestRender();
				};
			const unsub = fd.onBranchChange(() => render());
			return {
				dispose() {
					unsub();
				},
				invalidate() {
					render();
				},
				render: () => [],
			};
		});

		c.ui.setWidget(
			"df-top",
			(_t: any, theme: Theme) => ({
				dispose() {},
				invalidate() {
					reset();
				},
				render(w: number) {
					if (!ctx) return [];
					const l = getLayout(w, theme);
					return l.top ? [l.top] : [];
				},
			}),
			{ placement: "aboveEditor" },
		);

		c.ui.setWidget(
			"df-secondary",
			(_t: any, theme: Theme) => ({
				dispose() {},
				invalidate() {
					reset();
				},
				render(w: number) {
					if (!ctx) return [];
					const l = getLayout(w, theme);
					return l.secondary ? [l.secondary] : [];
				},
			}),
			{ placement: "belowEditor" },
		);
	});

	pi.on("session_shutdown", () => {
		ctx = null;
		footerData = null;
		getThinking = null;
		curThinking = null;
		liveUsage = null;
		tui = null;
		reset();
	});

	pi.on("turn_start", () => {
		streaming = true;
		liveUsage = null;
		reset();
	});
	pi.on("message_update", (e: any) => {
		if (
			e.message?.role === "assistant" &&
			e.assistantMessageEvent?.type === "usage" &&
			e.assistantMessageEvent.usage
		) {
			liveUsage = e.assistantMessageEvent.usage;
			render();
		}
	});
	pi.on("turn_end", () => {
		streaming = false;
		liveUsage = null;
		reset();
		render();
	});
	pi.on("thinking_level_select", (e: any) => {
		curThinking = e.level;
		reset();
		render();
	});
	pi.on("model_select", () => {
		reset();
		render();
	});
}
