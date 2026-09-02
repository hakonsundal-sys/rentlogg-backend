// Thin wrapper around Resend's HTTP API using the built-in fetch — no SDK dependency needed
// for a single POST call, matching this codebase's minimal-dependency style.
export async function sendEmail({ to, subject, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: process.env.REPORT_FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend feilet (${res.status}): ${await res.text()}`);
}
