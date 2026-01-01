import { getGitProvider } from './git-provider.js';
import { rootDir } from './git.js';
import { canonicalRepoKey } from './utils/canonicalRepoKey.js';
import { parseRepoAnnouncementEvent, RepoAnnouncementEvent } from '@nostr-git/shared-types';
import { assertRepoAnnouncementEvent } from './validation.js';

export interface Branch {
  name: string;
  oid?: string; // commit hash
  isHead: boolean;
}

export async function listBranchesFromEvent(opts: {
  repoEvent: RepoAnnouncementEvent;
}): Promise<Branch[]> {
  assertRepoAnnouncementEvent(opts.repoEvent);
  const repo = parseRepoAnnouncementEvent(opts.repoEvent);
  // Some repos announce only the name (e.g., "grasp") in tag d. Build a canonical key if needed.
  let canonicalKey: string;
  try {
    canonicalKey = canonicalRepoKey(repo.repoId);
  } catch (_) {
    // Fallback: combine pubkey with repo name or repoId and canonicalize again
    const fallbackId = `${opts.repoEvent.pubkey}:${repo.name || repo.repoId}`;
    canonicalKey = canonicalRepoKey(fallbackId);
  }

  const dir = `${rootDir}/${canonicalKey}`;
  const git = getGitProvider();
  
  // Get both local and remote branches
  const localBranches = await git.listBranches({ dir });
  let remoteBranches: string[] = [];
  
  try {
    // Try to get remote branches from origin
    remoteBranches = await git.listBranches({ dir, remote: 'origin' });
  } catch (error) {
    // If remote branches can't be listed (e.g., no remote configured), continue with local only
    console.warn("Could not list remote branches:", error);
  }
  
  // Combine local and remote branches, removing 'origin/' prefix from remote branch names
  const allBranches = new Set<string>();
  
  // Add local branches
  for (const branch of localBranches) {
    allBranches.add(branch);
  }
  
  // Add remote branches (remove 'origin/' prefix if present)
  for (const branch of remoteBranches) {
    const branchName = branch.startsWith('origin/') ? branch.slice(7) : branch;
    allBranches.add(branchName);
  }
  
  return Array.from(allBranches).map((name: string) => ({ name, isHead: false }));
}

/**
 * List all branches in a repo.
 */
export async function listBranches(opts: { url: string; dir: string }): Promise<Branch[]> {
  const git = getGitProvider();
  const branches = await git.listBranches({ dir: opts.dir, url: opts.url });
  return branches.map((name: string) => ({ name }));
}

/**
 * Create a new branch.
 */
export async function createBranch(opts: {
  owner: string;
  repo: string;
  branch: string;
  checkout?: boolean;
}): Promise<void> {
  const dir = `${rootDir}/${opts.owner}/${opts.repo}`;
  const git = getGitProvider();
  await git.branch({ dir, ref: opts.branch, checkout: opts.checkout });
}

/**
 * Delete a branch.
 */
export async function deleteBranch(opts: {
  owner: string;
  repo: string;
  branch: string;
}): Promise<void> {
  const dir = `${rootDir}/${opts.owner}/${opts.repo}`;
  const git = getGitProvider();
  await git.deleteBranch({ dir, ref: opts.branch });
}

/**
 * Rename a branch.
 */
export async function renameBranch(opts: {
  owner: string;
  repo: string;
  oldBranch: string;
  newBranch: string;
}): Promise<void> {
  const dir = `${rootDir}/${opts.owner}/${opts.repo}`;
  const git = getGitProvider();
  await git.renameBranch({ dir, oldref: opts.oldBranch, ref: opts.newBranch });
}
