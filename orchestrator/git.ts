import { spawn } from "node:child_process";
import type { GitContext } from "./types.ts";

const DEFAULT_GIT: GitContext = {
  branch: "unknown",
  hasUncommittedChanges: false,
  hasStagedChanges: false,
  aheadOfRemote: 0,
  behindRemote: 0,
  isMainBranch: false,
  recentCommitSubject: "",
};

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (command: string, args: string[], opts: { cwd: string }) => Promise<ExecResult>;

/**
 * Local git runner. Deliberately NOT pi.exec: pi's internal exec spawn omits
 * `windowsHide`, so on a console-less host every git call flashes a terminal
 * window. Ours passes windowsHide on every platform (a no-op off Windows).
 * Never rejects: spawn errors resolve as code 127 so callers can treat a
 * missing git the same as a failing one.
 */
export const hiddenExec: ExecFn = (command, args, { cwd }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    try {
      const proc = spawn(command, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      proc.stdout?.on("data", (d) => (stdout += d.toString()));
      proc.stderr?.on("data", (d) => (stderr += d.toString()));
      proc.on("error", (err) => resolve({ code: 127, stdout: "", stderr: err.message }));
      proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    } catch (err: any) {
      resolve({ code: 127, stdout: "", stderr: err?.message ?? String(err) });
    }
  });

export async function detectGitContext(cwd: string, exec: ExecFn = hiddenExec): Promise<GitContext> {
  try {
    const [branchRes, statusRes, logRes, revRes, headRes] = await Promise.all([
      exec("git", ["branch", "--show-current"], { cwd }),
      exec("git", ["status", "--porcelain"], { cwd }),
      // Unborn branch (fresh repo, no commits): log fails — tolerate like rev-list.
      exec("git", ["log", "-1", "--format=%s"], { cwd }).catch(() => null),
      exec("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd }).catch(() => null),
      exec("git", ["rev-parse", "HEAD"], { cwd }).catch(() => null),
    ]);
    const headSha = headRes?.code === 0 ? headRes.stdout.trim() : "";

    const branch = branchRes.stdout?.trim() || "unknown";
    // Do NOT trim() the whole output: the porcelain XY code is positional —
    // a leading space is the "unstaged" column and trimming the first line
    // would silently misreport ` M file` as a staged change.
    const statusLines = (statusRes.stdout ?? "")
      .split("\n")
      .map((l: string) => l.replace(/\r$/, ""))
      .filter(Boolean);
    // Porcelain XY: T = typechange, U = unmerged — both real changes the
    // previous regexes silently dropped alongside staged-only commits.
    const staged = statusLines.filter((l: string) => /^[MADRUCT]/.test(l));
    const unstaged = statusLines.filter((l: string) => /^.[MDTU?]/.test(l));

    let ahead = 0;
    let behind = 0;
    if (revRes?.stdout?.trim()) {
      const parts = revRes.stdout.trim().split(/\s+/);
      behind = parseInt(parts[0] || "0", 10);
      ahead = parseInt(parts[1] || "0", 10);
    }

    return {
      branch,
      // A staged-but-unstaged-clean commit ("A  file") read as "no changes"
      // before — the commit-archive gate would then think there was nothing
      // to commit while a staged change sat uncommitted.
      hasUncommittedChanges: staged.length > 0 || unstaged.length > 0,
      hasStagedChanges: staged.length > 0,
      aheadOfRemote: ahead,
      behindRemote: behind,
      isMainBranch: branch === "main" || branch === "master",
      recentCommitSubject: logRes?.stdout?.trim() || "",
      ...(/^[0-9a-f]{7,64}$/.test(headSha) ? { head: headSha } : {}),
    };
  } catch {
    return DEFAULT_GIT;
  }
}
