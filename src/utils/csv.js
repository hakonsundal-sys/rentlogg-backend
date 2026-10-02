// A cell that starts with = + - or @ is read by Excel as a formula, not as text. Several exported
// fields are typed by staff (names, notes, free-text deviations), so a value like
// =HYPERLINK("https://…", "Klikk her") would otherwise run on the payroll officer's machine when
// the file is opened. Prefixing a single quote makes Excel keep it as text.
//
// Applied only to strings, and not to anything that is plainly a number, date-like value or phone
// number (+47 91 23 45 67, -2,5, 2026-10-01) — those start with the same characters and must reach
// the spreadsheet untouched. Numbers passed as numbers never need it.
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?[\d\s.,:-]*\d[\d\s.,:-]*$/;

export function csvEscape(value) {
  let str = String(value ?? "");
  if (typeof value === "string" && FORMULA_START.test(str) && !PLAIN_NUMBER.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}
