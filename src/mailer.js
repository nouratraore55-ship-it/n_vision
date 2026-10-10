import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL } = process.env;

const isConfigured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && NOTIFY_EMAIL);

let transporter = null;
if (isConfigured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
} else {
  console.log(
    'ℹ️  Notifications email désactivées (SMTP_HOST / SMTP_USER / SMTP_PASS / NOTIFY_EMAIL manquants dans .env).'
  );
}

export async function notifyNewDevis(devis) {
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: `"Site N Vision" <${SMTP_USER}>`,
      to: NOTIFY_EMAIL,
      subject: `Nouvelle demande de devis — ${devis.contact || 'Client'}`,
      text: [
        `Nouvelle demande de devis reçue sur le site.`,
        ``,
        `Nom : ${devis.contact || '—'}`,
        `Email : ${devis.email || '—'}`,
        `Téléphone : ${devis.telephone || '—'}`,
        ``,
        `Va sur /admin pour voir le détail complet.`,
      ].join('\n'),
    });
  } catch (err) {
    console.error("Échec de l'envoi de la notification email :", err.message);
  }
}
