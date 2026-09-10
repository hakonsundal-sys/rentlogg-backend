import { Resend } from "resend";

// Switched from Gmail SMTP to Resend once rentlogg.no's DNS became directly reachable (Hakon
// owns the domain outright, unlike okv-gruppen.no which sits at DigitalOcean outside his
// access) — a real branded sender with proper DKIM/SPF instead of Gmail's 500/day limit and
// "via gmail.com" look. The API key only has Resend's "Sending access" scope, not domain
// management, matching least-privilege for what this service actually does.
let client;
function getClient() {
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

export async function sendEmail({ to, subject, html }) {
  const { error } = await getClient().emails.send({ from: process.env.REPORT_FROM_EMAIL, to, subject, html });
  if (error) throw new Error(error.message || "Failed to send email via Resend");
}
