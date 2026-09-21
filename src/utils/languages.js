// The UI languages Rentlogg ships. Norwegian is the source language and the fallback for every
// missing key, so it isn't a "translation" so much as the baseline the others are measured
// against. The other four were chosen by Håkon 2026-09-21 from the actual Vest/Øst rosters —
// most cleaners aren't Norwegian speakers, and they're the app's main users (QR check-in and
// checklists on a phone). Adding one later is a new entry here plus one JSON file on the
// frontend; nothing else in the code branches on the specific set.
export const SUPPORTED_LANGUAGES = ["no", "en", "lt", "lv", "ru"];
export const DEFAULT_LANGUAGE = "no";

// Stored as NULL rather than 'no' for an account that never chose — that way "never picked a
// language" and "deliberately picked Norwegian" stay distinguishable, which matters if we ever
// want to prompt someone once. Both render as Norwegian.
export function normalizeLanguage(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return undefined; // undefined = invalid, caller returns 400
  const lang = value.trim().toLowerCase();
  return SUPPORTED_LANGUAGES.includes(lang) ? lang : undefined;
}
