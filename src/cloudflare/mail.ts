export interface MailBindings {
  EMAIL: SendEmail;
  ALERT_FROM: string;
  ALERT_TO?: string;
}

export const sendMail = async (
  { EMAIL, ALERT_FROM, ALERT_TO }: MailBindings,
  subject: string,
  text: string,
): Promise<void> => {
  if (!ALERT_TO) throw new Error("there is nowhere to send the mail");
  await EMAIL.send({ to: ALERT_TO, from: ALERT_FROM, subject, text });
};
