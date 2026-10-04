/**
 * Skills — your saved skill library.
 *
 * A skill is a named instruction bundle an agent can carry into a run
 * (a repo of SKILL.md files, a prompt pack, a house style). Add one here,
 * then pick it in the task composer — it ships with the run to whichever
 * cloud agent executes it.
 */
import { useState, type JSX } from "react";
import { useSavedSkills, saveSkill, removeSkill } from "../saved";

const FIELD =
  "bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#1c1cc8] focus:ring-1 focus:ring-[#1c1cc8]/40 placeholder-[#6a6f63]/60 transition-colors";

export function SkillsView(): JSX.Element {
  const skills = useSavedSkills();
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addSkill = () => {
    const cleanName = name.trim();
    const cleanRepo = repoUrl.trim();
    if (!cleanName) {
      setError("Give the skill a name first.");
      return;
    }
    if (cleanRepo && !cleanRepo.startsWith("https://github.com/")) {
      setError("Skill repo must be a GitHub URL like https://github.com/owner/repo.");
      return;
    }
    saveSkill({
      name: cleanName,
      repoUrl: cleanRepo || undefined,
      notes: notes.trim() || undefined,
    });
    setName("");
    setRepoUrl("");
    setNotes("");
    setError(null);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f6f4ed] text-[#222320]">
      <div className="border-b border-[#e0ded5] bg-[#f1efe6] px-4 lg:px-8 py-4 shrink-0">
        <h2 className="text-base font-semibold text-[#222320]">Skills</h2>
        <p className="text-xs text-[#6a6f63]">
          Saved instruction bundles your agents can use on any run. Pick them in the task composer — they ship with the run to the cloud agent.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-3xl mx-auto flex flex-col gap-4">
          <div className="rounded-none border border-[#d3d2c8] bg-[#fffef8] p-4 flex flex-col gap-2.5 shadow-[3px_3px_0_var(--paper-shadow)]">
            <div className="text-xs font-semibold text-[#222320]">Add a skill</div>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Skill name — e.g. PR review checklist"
              aria-label="Skill name"
              className={`${FIELD} w-full`}
            />
            <input
              type="url"
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
              placeholder="Optional GitHub repo — https://github.com/owner/repo"
              aria-label="Skill repository"
              className={`${FIELD} w-full font-mono`}
            />
            <input
              type="text"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Optional note — what this skill does"
              aria-label="Skill notes"
              className={`${FIELD} w-full`}
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={addSkill}
                className="text-[11px] bg-[#0000a8]/10 hover:bg-[#0000a8]/15 border border-[#0000a8]/15 text-[#1c1cc8] font-medium py-1.5 px-3 rounded-none transition-colors"
              >
                Save skill
              </button>
              {error ? <span className="text-[11px] text-[#fb2c36]">{error}</span> : null}
            </div>
          </div>

          {skills.length === 0 ? (
            <div className="rounded-none border border-dashed border-[#d3d2c8] bg-[#f9f8f2] p-6 text-center text-xs text-[#6a6f63]">
              No skills saved yet — add one above, or open the task composer to pick skills when you run a task.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {skills.map((skill) => (
                <li
                  key={skill.id}
                  className="rounded-none border border-[#d3d2c8] bg-[#fffef8] px-4 py-3 flex items-start justify-between gap-3 shadow-[2px_2px_0_var(--paper-shadow)]"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#222320]">{skill.name}</div>
                    {skill.repoUrl ? (
                      <div className="text-[11px] font-mono text-[#6a6f63] truncate">{skill.repoUrl}</div>
                    ) : null}
                    {skill.notes ? (
                      <div className="text-[11px] text-[#6a6f63] mt-0.5">{skill.notes}</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeSkill(skill.id)}
                    aria-label={`Remove ${skill.name}`}
                    className="shrink-0 text-[11px] bg-transparent hover:bg-[#fb2c36]/10 border border-[#e0ded5] hover:border-[#fb2c36]/50 text-[#6a6f63] hover:text-[#fb2c36] font-medium py-1 px-2.5 rounded-none transition-colors"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
