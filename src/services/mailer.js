import nodemailer from "nodemailer";

// Gmail SMTP via an app-specific password — no domain/DNS verification needed, unlike Resend,
// which made it the pragmatic interim choice while okv-gruppen.no's DNS (at DigitalOcean,
// outside Hakon's access) isn't set up yet. Gmail requires the "From" address to be the
// authenticated mailbox itself (or a verified alias), so REPORT_FROM_EMAIL's address portion
// must match GMAIL_USER — only the display name is free to customize.
let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

export async function sendEmail({ to, subject, html }) {
  await getTransporter().sendMail({ from: process.env.REPORT_FROM_EMAIL, to, subject, html });
}
