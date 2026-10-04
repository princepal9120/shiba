/**
 * Client-side saved library: repositories and skills.
 *
 * Both are user-curated picks kept in localStorage so the task composer and
 * the Skills surface never start empty — no backend round-trip needed for
 * what's essentially a bookmark list. Seeding from run history happens in
 * app.tsx so the picker shows real repos on first use.
 */
import { useCallback, useSyncExternalStore } from "react";

export interface SavedSkill {
  id: string;
  name: string;
  /** Optional GitHub repo the skill comes from (SKILL.md library, prompts, etc.). */
  repoUrl?: string;
  notes?: string;
}

const REPOS_KEY = "shiba-repos-v1";
const SKILLS_KEY = "shiba-skills-v1";

function readList<T>(key: string, isValid: (item: unknown) => item is T): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isValid) : [];
  } catch {
    return [];
  }
}

function writeList(key: string, items: unknown[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Storage full or blocked — the pickers still work for the session via the
    // in-memory snapshot below.
  }
  subscribers.forEach((notify) => notify());
}

const subscribers = new Set<() => void>();
function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

// Snapshot caches so useSyncExternalStore gets a stable reference per change.
let reposCache: string[] | null = null;
let skillsCache: SavedSkill[] | null = null;

const isRepo = (item: unknown): item is string =>
  typeof item === "string" && item.length > 0;
const isSkill = (item: unknown): item is SavedSkill =>
  typeof item === "object" && item !== null &&
  typeof (item as SavedSkill).id === "string" &&
  typeof (item as SavedSkill).name === "string";

export function getSavedRepos(): string[] {
  if (reposCache === null) reposCache = readList(REPOS_KEY, isRepo);
  return reposCache;
}

export function getSavedSkills(): SavedSkill[] {
  if (skillsCache === null) skillsCache = readList(SKILLS_KEY, isSkill);
  return skillsCache;
}

export function useSavedRepos(): string[] {
  return useSyncExternalStore(subscribe, getSavedRepos, () => []);
}

export function useSavedSkills(): SavedSkill[] {
  return useSyncExternalStore(subscribe, getSavedSkills, () => []);
}

export function useSaveRepo(): (url: string) => void {
  return useCallback((url: string) => saveRepo(url), []);
}

function invalidate(): void {
  reposCache = null;
  skillsCache = null;
}

export function saveRepo(url: string): void {
  const clean = url.trim();
  if (!clean) return;
  invalidate();
  const current = getSavedRepos();
  if (current.includes(clean)) return;
  reposCache = [...current, clean];
  writeList(REPOS_KEY, reposCache);
}

export function removeRepo(url: string): void {
  invalidate();
  reposCache = getSavedRepos().filter((repo) => repo !== url);
  writeList(REPOS_KEY, reposCache);
}

export function saveSkill(skill: Omit<SavedSkill, "id">): SavedSkill {
  invalidate();
  const entry: SavedSkill = {
    ...skill,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
  skillsCache = [...getSavedSkills(), entry];
  writeList(SKILLS_KEY, skillsCache);
  return entry;
}

export function removeSkill(id: string): void {
  invalidate();
  skillsCache = getSavedSkills().filter((skill) => skill.id !== id);
  writeList(SKILLS_KEY, skillsCache);
}
