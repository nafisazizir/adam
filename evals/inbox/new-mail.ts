import type { EmailSummary } from "#lib/google.js";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);

function email(id: string, fields: Partial<EmailSummary>): EmailSummary {
  return {
    account: "personal",
    id,
    threadId: id,
    from: "",
    to: "nafis@gmail.example",
    subject: "",
    date: minutesAgo(2),
    snippet: "",
    unread: true,
    important: false,
    category: "primary",
    ...fields,
  };
}

export const newsletters: EmailSummary[] = [
  email("n1", {
    from: "The Morning Brew <crew@morningbrew.example>",
    subject: "☕ Markets wobble, and the best new gadgets",
    snippet: "Good morning. Here's what you need to know today. Stocks slipped as...",
    category: "primary",
  }),
  email("n2", {
    from: "Uber Receipts <noreply@uber.example>",
    subject: "Your Saturday morning trip with Uber",
    snippet: "Thanks for riding, Nafis. Total A$23.40. Rate your driver.",
    category: "updates",
    important: true,
  }),
  email("n3", {
    from: "GitHub <noreply@github.example>",
    subject: "[adam] CI passed on main",
    snippet: "All checks have passed for commit 80278b6.",
    category: "updates",
    important: true,
  }),
];

export const timeSensitive: EmailSummary[] = [
  ...newsletters.slice(0, 1),
  email("p1", {
    from: "Mia Chen <mia.chen@gmail.example>",
    subject: "dinner tomorrow moved to 6:30?",
    snippet:
      "hey! the restaurant can only do 6:30 tomorrow now instead of 7:30, can you still make it? I need to confirm with them tonight",
    important: true,
  }),
];
