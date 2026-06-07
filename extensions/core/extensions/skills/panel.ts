import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

import { formatSeen } from "./stats.ts";
import type { SkillRow, SkillsTheme, SkillSortMode } from "./types.ts";

/** Pad text to a visible width after truncating ANSI-aware content. */
function pad(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** Interactive browser for skill commands, status, cost estimates, and usage stats. */
export class SkillsPanel implements Focusable {
  focused = false;
  private selected = 0;
  private scroll = 0;
  private query = "";
  private searchActive = false;
  private sort: SkillSortMode = "scope";

  /** Build the panel around static skill rows captured when `/skills` was invoked. */
  constructor(
    private skills: SkillRow[],
    private tui: TUI,
    private theme: SkillsTheme,
    private done: (command: string | null) => void,
  ) {}

  /** Handle search, sorting, movement, dismissal, and skill selection keystrokes. */
  handleInput(data: string): void {
    if (this.searchActive) {
      if (matchesKey(data, "return")) {
        this.selectSkill();
      } else if (matchesKey(data, "escape")) {
        this.searchActive = false;
      } else if (matchesKey(data, "backspace")) {
        this.query = this.query.slice(0, -1);
        this.selected = 0;
        this.scroll = 0;
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.query += data;
        this.selected = 0;
        this.scroll = 0;
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || data === "q") {
      this.done(null);
      return;
    }
    if (data === "/") this.searchActive = true;
    else if (data === "t") this.cycleSort();
    else if (matchesKey(data, "up")) this.move(-1);
    else if (matchesKey(data, "down")) this.move(1);
    else if (matchesKey(data, "ctrl+u")) this.move(-10);
    else if (matchesKey(data, "ctrl+d")) this.move(10);
    else if (matchesKey(data, "home")) this.selected = 0;
    else if (matchesKey(data, "end")) this.selected = Math.max(0, this.filtered().length - 1);
    else if (matchesKey(data, "return")) this.selectSkill();
    else return;

    this.keepSelectionVisible();
    this.tui.requestRender();
  }

  /** Render the browser header, search box, rows, and selected-skill details. */
  render(width: number): string[] {
    const th = this.theme;
    const rows = this.filtered();
    const selectedSkill = rows[this.selected];
    const groups = this.groupRows(rows);
    const header = " Skills";
    const help = ` ${this.skills.length} skills · / search · t sort (${this.sort}) · ↑/↓ move · Enter insert · Esc/q close`;
    const searchText = this.query || "Search skills…";
    const border = (text: string) => th.fg("border", text);
    const innerWidth = Math.max(20, width - 4);
    const searchLine = `${border("╭")}${border("─".repeat(innerWidth))}${border("╮")}`;
    const searchBody = `${border("│")}${pad(
      ` ${this.searchActive ? "⌕" : " "} ${this.query ? searchText : th.fg("dim", searchText)}`,
      innerWidth,
    )}${border("│")}`;
    const listHeight = 22;
    const visibleList = groups.slice(this.scroll, this.scroll + listHeight);
    const lines = [
      th.fg("accent", th.bold(header)),
      th.fg("dim", help),
      "",
      ` ${searchLine}`,
      ` ${searchBody}`,
      ` ${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`,
      "",
    ];

    for (const item of visibleList) {
      if (item.type === "group") {
        lines.push(th.fg("muted", ` ${item.label}`));
        continue;
      }
      const skill = item.skill;
      const index = rows.indexOf(skill);
      const marker = index === this.selected ? th.fg("accent", "❯") : " ";
      const status = skill.status === "on" ? th.fg("success", "on") : th.fg("warning", "user-only");
      const row = `${marker} ${pad(status, 12)} ${pad(skill.name, 26)} ${pad(skill.scope, 10)} ${pad(
        `~${skill.tokens} tks`,
        9,
      )} ${th.fg("dim", skill.description)}`;
      lines.push(truncateToWidth(row, width, ""));
    }

    lines.push("");
    if (selectedSkill) this.renderSelectedSkill(lines, selectedSkill, width);
    else lines.push(th.fg("dim", " No matching skills"));

    return lines;
  }

  /** No-op required by the Pi custom component lifecycle. */
  invalidate(): void {}

  /** Return filtered and sorted skill rows for the current query and sort mode. */
  private filtered(): SkillRow[] {
    const query = this.query.trim().toLowerCase();
    const rows = query
      ? this.skills.filter((skill) =>
          `${skill.name} ${skill.description} ${skill.scope}`.toLowerCase().includes(query),
        )
      : [...this.skills];

    return rows.sort((a, b) => {
      if (this.sort === "name") return a.name.localeCompare(b.name);
      if (this.sort === "tokens") return b.tokens - a.tokens || a.name.localeCompare(b.name);
      return a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name);
    });
  }

  /** Insert scope separators when sorting by scope. */
  private groupRows(
    rows: SkillRow[],
  ): Array<{ type: "group"; label: string } | { type: "skill"; skill: SkillRow }> {
    const result: Array<{ type: "group"; label: string } | { type: "skill"; skill: SkillRow }> = [];
    let lastScope = "";
    for (const skill of rows) {
      if (this.sort === "scope" && skill.scope !== lastScope) {
        if (result.length > 0) result.push({ type: "group", label: "" });
        lastScope = skill.scope;
        result.push({ type: "group", label: `${skill.scope.toUpperCase()} SKILLS` });
      }
      result.push({ type: "skill", skill });
    }
    return result;
  }

  /** Move the selected skill by a signed delta. */
  private move(delta: number): void {
    this.selected = Math.max(0, Math.min(this.filtered().length - 1, this.selected + delta));
  }

  /** Rotate between available sort modes. */
  private cycleSort(): void {
    this.sort = this.sort === "scope" ? "name" : this.sort === "name" ? "tokens" : "scope";
    this.selected = 0;
    this.scroll = 0;
  }

  /** Resolve the browser with a slash command for the selected skill. */
  private selectSkill(): void {
    const skill = this.filtered()[this.selected];
    if (skill) this.done(`/skill:${skill.name} `);
  }

  /** Keep the selected row inside the fixed list viewport. */
  private keepSelectionVisible(): void {
    const rows = this.filtered();
    this.selected = Math.max(0, Math.min(rows.length - 1, this.selected));
    const grouped = this.groupRows(rows);
    const selectedRow = rows[this.selected];
    const groupedIndex = grouped.findIndex(
      (item) => item.type === "skill" && item.skill === selectedRow,
    );
    if (groupedIndex < this.scroll) this.scroll = groupedIndex;
    else if (groupedIndex >= this.scroll + 22) this.scroll = groupedIndex - 21;
    this.scroll = Math.max(0, this.scroll);
  }

  /** Append selected-skill details and usage statistics to rendered lines. */
  private renderSelectedSkill(lines: string[], selectedSkill: SkillRow, width: number): void {
    const stats = selectedSkill.stats;
    lines.push(this.theme.fg("accent", ` ${selectedSkill.name}`));
    lines.push(truncateToWidth(` ${selectedSkill.description || "No description"}`, width, ""));
    lines.push(this.theme.fg("dim", truncateToWidth(` ${selectedSkill.path}`, width, "")));
    lines.push(
      truncateToWidth(
        ` scope: ${selectedSkill.scope} · status: ${selectedSkill.status} · prompt cost: ~${selectedSkill.tokens} tokens`,
        width,
        "",
      ),
    );
    lines.push("");
    lines.push(this.theme.fg("accent", " Usage"));
    lines.push(
      truncateToWidth(
        ` user selected: ${stats.userUsed} · last: ${formatSeen(stats.lastUser)}`,
        width,
        "",
      ),
    );
    lines.push(
      truncateToWidth(
        ` agent loaded:  ${stats.agentLoaded} · last: ${formatSeen(stats.lastAgent)}`,
        width,
        "",
      ),
    );
    lines.push(
      this.theme.fg(
        "dim",
        truncateToWidth(
          ` tracked paths: ${stats.paths.length ? stats.paths.join(", ") : "none"}`,
          width,
          "",
        ),
      ),
    );
  }
}
