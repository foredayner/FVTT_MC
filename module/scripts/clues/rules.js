// Skill checks for clues, behind one small interface so the clue system does not know the rules.
//
// A rule set ("adapter") says which skills there are and how a check is rolled. The first one is
// Call of Cthulhu 7th edition; a plain percentile one stands in for anything else. Another game
// is added by writing an adapter with the same shape and registering it.
//
//   adapter.id                       "coc7"
//   adapter.skills                   [{ key, label }]: what a clue's check may use
//   adapter.difficulties             [{ key, label }]
//   adapter.perception               the skill key of the automatic spotting check
//   adapter.check(actor, skill, difficulty, { blind, flavor }) -> { success, level, total, target, label }

import { MODULE_ID, L } from "../constants.js";

/** Skill names as they appear on character sheets (English and Korean), by key. */
const COC_SKILLS = {
  spot: ["Spot Hidden", "관찰력"],
  listen: ["Listen", "듣기"],
  library: ["Library Use", "자료조사", "도서관 이용"],
  psychology: ["Psychology", "심리학"],
  occult: ["Occult", "오컬트"],
  history: ["History", "역사"],
  locksmith: ["Locksmith", "열쇠공"],
  medicine: ["Medicine", "의학"],
  firstAid: ["First Aid", "응급처치"],
  appraise: ["Appraise", "감정"],
  naturalWorld: ["Natural World", "박물학"],
  track: ["Track", "추적"],
  science: ["Science", "과학"],
  archaeology: ["Archaeology", "고고학"],
  anthropology: ["Anthropology", "인류학"],
  cthulhuMythos: ["Cthulhu Mythos", "크툴루 신화"],
  otherLanguage: ["Language (Other)", "외국어"],
  law: ["Law", "법률"],
  mechRepair: ["Mechanical Repair", "기계수리"],
  elecRepair: ["Electrical Repair", "전기수리"],
  pharmacy: ["Pharmacy", "약학"],
  idea: ["INT", "지능", "아이디어"],
  luck: ["Luck", "행운"]
};
/** Starting values when a character has no such skill on its sheet. */
const COC_BASE = {
  spot: 25, listen: 20, library: 20, psychology: 10, occult: 5, history: 5, locksmith: 1, medicine: 1, firstAid: 30,
  appraise: 5, naturalWorld: 10, track: 10, science: 1, archaeology: 1, anthropology: 1, cthulhuMythos: 0,
  otherLanguage: 1, law: 5, mechRepair: 10, elecRepair: 10, pharmacy: 1, idea: 50, luck: 50
};

const DIFFICULTIES = ["regular", "hard", "extreme"];

/** The percentile roll and its result levels, as in Call of Cthulhu. */
export function percentile(total, value, difficulty) {
  const target = difficulty === "extreme" ? Math.floor(value / 5) : difficulty === "hard" ? Math.floor(value / 2) : value;
  const fumble = value < 50 ? total >= 96 : total === 100;
  let level;
  if (total === 1) level = "critical";
  else if (fumble) level = "fumble";
  else if (total <= Math.floor(value / 5)) level = "extreme";
  else if (total <= Math.floor(value / 2)) level = "hard";
  else if (total <= value) level = "regular";
  else level = "failure";
  const rank = { critical: 4, extreme: 3, hard: 2, regular: 1, failure: 0, fumble: -1 };
  const need = { regular: 1, hard: 2, extreme: 3 }[difficulty] ?? 1;
  return { target, level, success: rank[level] >= need };
}

/** A character's value for a skill on a Call of Cthulhu sheet (or the starting value). */
export function cocSkillValue(actor, key) {
  const names = (COC_SKILLS[key] ?? [key]).map((n) => n.toLowerCase());
  if (key === "luck") {
    const v = actor?.system?.attribs?.lck?.value;
    if (Number.isFinite(Number(v))) return Number(v);
  }
  if (key === "idea") {
    const v = actor?.system?.characteristics?.int?.value;
    if (Number.isFinite(Number(v))) return Number(v);
  }
  for (const item of actor?.items ?? []) {
    if (item.type !== "skill") continue;
    const name = String(item.name ?? "").toLowerCase();
    if (!names.some((n) => name === n || name.startsWith(n))) continue;
    const direct = Number(item.value ?? item.system?.value ?? item.system?.rawValue);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const sys = item.system ?? {};
    const adj = sys.adjustments ?? {};
    const sum = Number(sys.base ?? 0) + ["personal", "occupation", "archetype", "experience"].reduce((a, k) => a + Number(adj[k] ?? 0), 0);
    if (Number.isFinite(sum) && sum > 0) return sum;
  }
  return COC_BASE[key] ?? 1;
}

class PercentileAdapter {
  constructor({ id, skills, values, perception }) {
    this.id = id;
    this.skillNames = skills;
    this.valueOf = values;
    this.perception = perception;
  }

  get skills() {
    const ko = game.i18n.lang === "ko";
    return Object.entries(this.skillNames).map(([key, names]) => ({ key, label: ko && names[1] ? names[1] : names[0] }));
  }

  get difficulties() {
    return DIFFICULTIES.map((key) => ({ key, label: L(`Clue.Difficulty.${key}`) }));
  }

  skillLabel(key) {
    return this.skills.find((s) => s.key === key)?.label ?? key;
  }

  async check(actor, skill, difficulty = "regular", { blind = false, flavor = "" } = {}) {
    const value = this.valueOf(actor, skill);
    const roll = await new Roll("1d100").evaluate();
    const r = percentile(roll.total, value, difficulty);
    const label = `${this.skillLabel(skill)} (${L(`Clue.Difficulty.${difficulty}`)})`;
    const result = { ...r, total: roll.total, value, label };
    const content = `<div class="bwb-check"><strong>${foundry.utils.escapeHTML(flavor || label)}</strong><br>`
      + `${foundry.utils.escapeHTML(actor?.name ?? "")}: ${roll.total} / ${r.target} → `
      + `<span class="bwb-check-${r.success ? "ok" : "fail"}">${L(`Clue.Level.${r.level}`)}</span></div>`;
    const gms = game.users.filter((u) => u.isGM).map((u) => u.id);
    await ChatMessage.create({
      content,
      speaker: actor ? ChatMessage.getSpeaker({ actor }) : undefined,
      whisper: blind ? gms : [],
      blind,
      rolls: [roll],
      flags: { [MODULE_ID]: { check: { skill, difficulty, success: r.success } } }
    });
    return result;
  }
}

const ADAPTERS = new Map();

export function registerRules(adapter) {
  ADAPTERS.set(adapter.id, adapter);
}

registerRules(new PercentileAdapter({ id: "coc7", skills: COC_SKILLS, values: cocSkillValue, perception: "spot" }));
// Any other game for now: the same percentile roll, a sheet value under the skill's name, else 50.
registerRules(new PercentileAdapter({
  id: "generic",
  skills: { perception: ["Perception", "지각"], investigation: ["Investigation", "조사"], knowledge: ["Knowledge", "지식"], luck: ["Luck", "행운"] },
  values: (actor, key) => {
    const item = actor?.items?.find((i) => String(i.name).toLowerCase() === key.toLowerCase());
    const v = Number(item?.system?.value);
    return Number.isFinite(v) && v > 0 ? v : 50;
  },
  perception: "perception"
}));

/** The rule set in use: the world setting, or the game system's own when it has one. */
export function rules() {
  let id = "auto";
  try { id = game.settings.get(MODULE_ID, "clueRules"); } catch { /* not registered yet */ }
  if (id === "auto") id = String(game.system?.id ?? "").toLowerCase() === "coc7" ? "coc7" : "generic";
  return ADAPTERS.get(id) ?? ADAPTERS.get("generic");
}

export function ruleIds() {
  return [...ADAPTERS.keys()];
}
