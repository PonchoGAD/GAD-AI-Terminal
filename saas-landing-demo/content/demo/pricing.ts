export type PricingPlan = {
  id: string;
  name: string;
  price: string;
  features: string[];
  highlight?: boolean;
};

export const plans: PricingPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    price: '$0',
    features: ['Landing pages', 'Basic SEO'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$19',
    features: ['i18n', 'Advanced SEO', 'Priority support'],
    highlight: true,
  },
  {
    id: 'business',
    name: 'Business',
    price: '$49',
    features: ['Custom setup', 'Consulting'],
  },
];
