<script lang="ts">
  import { formatDistanceToNow } from "date-fns";
  import { Copy, Check } from "@lucide/svelte";
  import NostrAvatar from "./NostrAvatar.svelte";
  import BaseItemCard from "../BaseItemCard.svelte";

  // Real git commit data structure
  interface GitCommitData {
    oid: string;
    commit: {
      message: string;
      author: {
        name: string;
        email: string;
        timestamp: number;
      };
      committer: {
        name: string;
        email: string;
        timestamp: number;
      };
      parent: string[];
    };
  }

  interface CommitCardProps {
    commit: GitCommitData;
    onReact?: (commitId: string, type: "heart") => void;
    onComment?: (commitId: string, comment: string) => void;
    onNavigate?: (commitId: string) => void;
    href?: string; // Optional direct href for navigation
    getParentHref?: (commitId: string) => string; // Function to generate parent commit href
    // Optional avatar and display name supplied by app layer
    avatarUrl?: string;
    displayName?: string;
    pubkey?: string; // Optional Nostr pubkey for ProfileComponent avatar
    nip05?: string;
    nip39?: string;
  }

  let {
    commit,
    onNavigate,
    href,
    getParentHref,
    avatarUrl,
    displayName,
    pubkey,
    nip05,
    nip39,
  }: CommitCardProps = $props();

  let copied = $state(false);

  function truncateHash(hash: string): string {
    return hash.substring(0, 7);
  }

  function formatDate(timestamp: number): string {
    return formatDistanceToNow(new Date(timestamp * 1000), { addSuffix: true });
  }

  function copyHash() {
    navigator.clipboard.writeText(commit.oid);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  // Build href fallback
  const computedHref = $derived(() => href || undefined);
</script>

<BaseItemCard clickable={true} href={computedHref()} variant="commit">
  <!-- title -->
  {#snippet slotTitle()}
    {commit.commit.message}
  {/snippet}

  <!-- body content (empty for commits) -->
  {#snippet children()}{/snippet}

  <!-- meta row: author + time + commit hash -->
  {#snippet slotMeta()}
    <div class="flex items-center flex-wrap gap-2">
      <NostrAvatar
        pubkey={pubkey}
        avatarUrl={avatarUrl}
        nip05={nip05}
        nip39={nip39}
        email={commit.commit.author.email || commit.commit.committer?.email}
        displayName={displayName || commit.commit.author.name}
        size={40}
        class="h-10 w-10"
        title={displayName || commit.commit.author.name}
        responsive={true}
      />
      <span class="font-semibold text-sm truncate">{displayName || commit.commit.author.name}</span>
      {#if commit.commit.author.email}
        <span class="truncate text-xs text-muted-foreground" title={commit.commit.author.email}>
          {commit.commit.author.email}
        </span>
      {/if}
      <span class="text-xs text-muted-foreground whitespace-nowrap">
        • {formatDate(commit.commit.author.timestamp)}
      </span>
      <button
        onclick={copyHash}
        class="font-mono text-xs bg-muted px-2 py-1 rounded hover:bg-muted/80 transition-colors flex items-center gap-1"
        aria-label="Copy commit hash"
        title={commit.oid}
      >
        {truncateHash(commit.oid)}
        {#if copied}
          <Check class="h-3 w-3 text-green-500" />
        {:else}
          <Copy class="h-3 w-3" />
        {/if}
      </button>
    </div>
  {/snippet}

  <!-- footer actions: react/comment and parent -->
  {#snippet slotFooter()}
    <div class="flex items-center justify-between w-full">
      {#if commit.commit.parent.length > 0}
        {#if getParentHref}
          <a
            href={getParentHref(commit.commit.parent[0])}
            class="text-xs text-muted-foreground whitespace-nowrap hover:text-foreground hover:underline transition-colors"
          >
            Parent: {truncateHash(commit.commit.parent[0])}
          </a>
        {:else}
          <div class="text-xs text-muted-foreground whitespace-nowrap">
            Parent: {truncateHash(commit.commit.parent[0])}
          </div>
        {/if}
      {/if}
    </div>
  {/snippet}
</BaseItemCard>
