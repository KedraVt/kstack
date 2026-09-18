import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export async function detectGitContext(cwd: string, pi: ExtensionAPI): Promise<GitContext> {
  try {
    const [branchRes, statusRes, logRes, revRes] = await Promise.all([
      pi.exec("git", ["branch", "--show-current"], { cwd }),
      pi.exec("git", ["status", "--porcelain"], { cwd }),
      // Unborn branch (fresh repo, no commits): log fails — tolerate like rev-list.
      pi.exec("git", ["log", "-1", "--format=%s"], { cwd }).catch(() => null),
      pi.exec("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd }).catch(() => null),
    ]);

    const branch = branchRes.stdout?.trim() || "unknown";
    const statusLines = (statusRes.stdout?.trim() || "").split("\n").filter(Boolean);
    const staged = statusLines.filter((l: string) => /^[MADRC]/.test(l));
    const unstaged = statusLines.filter((l: string) => /^.[MD?]/.test(l));

    let ahead = 0;
    let behind = 0;
    if (revRes?.stdout?.trim()) {
      const parts = revRes.stdout.trim().split(/\s+/);
      behind = parseInt(parts[0] || "0", 10);
      ahead = parseInt(parts[1] || "0", 10);
    }

    return {
      branch,
      hasUncommittedChanges: unstaged.length > 0,
      hasStagedChanges: staged.length > 0,
      aheadOfRemote: ahead,
      behindRemote: behind,
      isMainBranch: branch === "main" || branch === "master",
      recentCommitSubject: logRes?.stdout?.trim() || "",
    };
  } catch {
    return DEFAULT_GIT;
  }
}
