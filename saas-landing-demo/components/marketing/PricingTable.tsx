import { plans } from '@/content/demo/pricing';

export default function PricingTable() {
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {plans.map(plan => (
        <div
          key={plan.id}
          className={`rounded border p-6 ${
            plan.highlight ? 'border-black' : 'border-gray-200'
          }`}
        >
          <h3 className="text-xl font-semibold">{plan.name}</h3>
          <p className="mt-2 text-3xl font-bold">{plan.price}</p>

          <ul className="mt-6 space-y-2 text-sm text-gray-600">
            {plan.features.map(feature => (
              <li key={feature}>• {feature}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
