import PricingTable from '@/components/marketing/PricingTable';

export const metadata = {
  title: 'Pricing',
};

export default function PricingPage() {
  return (
    <section className="py-20">
      <h1 className="text-3xl font-bold">Pricing</h1>
      <p className="mt-4 text-gray-600">
        Simple plans for early-stage SaaS products.
      </p>
      <div className="mt-12">
        <PricingTable />
      </div>
    </section>
  );
}
