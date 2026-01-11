export type FAQItem = {
  q: string;
  a: string;
};

export const faq: FAQItem[] = [
  {
    q: 'Is this project production ready?',
    a: 'Yes, as a SaaS landing demo.'
  },
  {
    q: 'Does it include backend?',
    a: 'No. Backend is intentionally excluded.'
  }
];
