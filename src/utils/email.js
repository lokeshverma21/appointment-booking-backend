// src/utils/email.js
export async function sendEmail({ to, subject, html, text }) {
  // TODO: replace with real provider (nodemailer / SendGrid / SES)
  // In dev you can console.log or store to a file.
  console.log("Sending email:", { to, subject });
  // Example: await sendgrid.send({ to, subject, html });
  return true;
}
